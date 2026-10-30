// A LocalSend v2 device (https://github.com/localsend/protocol): multicast
// discovery, sending, and an HTTPS server that receives files once the
// widget accepts them. It reuses the LocalSend app's name and certificate,
// so other devices see the same device the app was.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import Soup from 'gi://Soup?version=3.0';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_async');
Gio._promisify(Gio.File.prototype, 'move_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async');

const MULTICAST_GROUP = '224.0.0.167';
const DEFAULT_PORT = 53317;
const API = '/api/localsend/v2';
const PEER_TTL_MS = 10 * 60 * 1000;
const RETRY_BIND_SECONDS = 30;
const ANSWER_TIMEOUT_SECONDS = 120; // unanswered requests are declined
const TLS_RETRIES = 3;

const APP_ID = 'org.localsend.localsend_app';
// The LocalSend app (Flutter) keeps its settings, name and certificate here
const APP_PREFS = [
    [GLib.get_home_dir(), '.var', 'app', APP_ID, 'data', APP_ID, 'shared_preferences.json'],
    [GLib.get_user_data_dir(), APP_ID, 'shared_preferences.json'],
];
const OWN_DIR = [GLib.get_user_data_dir(), 'gnotch', 'localsend'];

export class LocalSendError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code; // 'pin', 'declined', 'busy', 'failed'
    }
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function readJson(bytes) {
    try {
        return JSON.parse(decoder.decode(bytes));
    } catch {
        return null;
    }
}

/** Upper-case SHA-256 of the certificate, as LocalSend computes fingerprints. */
function fingerprintOf(certificate) {
    return GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, certificate.certificate).toUpperCase();
}

/**
 * This computer's LocalSend identity: the app's own name and certificate,
 * or a generated one when the app was never set up.
 */
async function loadIdentity() {
    const download = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ?? GLib.get_home_dir();
    for (const parts of APP_PREFS) {
        let prefs;
        try {
            const [contents] = await Gio.File.new_for_path(GLib.build_filenamev(parts)).load_contents_async(null);
            prefs = readJson(contents);
        } catch {
            continue;
        }
        const security = typeof prefs?.['flutter.ls_security_context'] === 'string'
            ? JSON.parse(prefs['flutter.ls_security_context']) : null;
        if (!security?.certificate || !security.privateKey)
            continue;
        const certificate = Gio.TlsCertificate.new_from_pem(`${security.certificate}\n${security.privateKey}`, -1);
        return {
            alias: prefs['flutter.ls_alias'] ?? GLib.get_host_name(),
            port: prefs['flutter.ls_port'] ?? DEFAULT_PORT,
            certificate,
            fingerprint: fingerprintOf(certificate),
            destination: prefs['flutter.ls_destination'] ?? download,
        };
    }

    // No LocalSend app: a certificate of our own, made once with openssl
    const dir = GLib.build_filenamev(OWN_DIR);
    const certPath = GLib.build_filenamev([dir, 'cert.pem']);
    const keyPath = GLib.build_filenamev([dir, 'key.pem']);
    if (!GLib.file_test(certPath, GLib.FileTest.EXISTS)) {
        GLib.mkdir_with_parents(dir, 0o700);
        const proc = Gio.Subprocess.new(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', keyPath, '-out', certPath, '-days', '3650', '-subj', '/CN=LocalSend User'],
        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        await proc.wait_check_async(null);
    }
    const certificate = Gio.TlsCertificate.new_from_files(certPath, keyPath);
    return {
        alias: GLib.get_host_name(),
        port: DEFAULT_PORT,
        certificate,
        fingerprint: fingerprintOf(certificate),
        destination: download,
    };
}

/** "../a/b.txt" -> "a/b.txt": relative, no parent hops, no empty parts. */
function safeRelativePath(name) {
    const parts = String(name).split(/[/\\]+/).filter(p => p && p !== '.' && p !== '..');
    return parts.length ? parts.join('/') : 'file';
}

/** First free "name.ext", "name (1).ext", ... in the file's folder. */
function uniqueFile(file) {
    if (!file.query_exists(null))
        return file;
    const dir = file.get_parent();
    const base = file.get_basename();
    const dot = base.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
    for (let i = 1; ; i++) {
        const candidate = dir.get_child(`${stem} (${i})${ext}`);
        if (!candidate.query_exists(null))
            return candidate;
    }
}

/**
 * An incoming transfer, from the request until every file has arrived.
 * The widget decides with accept() or decline().
 */
class IncomingSession {
    constructor(device, msg, request, ip) {
        this._device = device;
        this._msg = msg;
        this.id = GLib.uuid_string_random();
        this.sender = {...request.info, ip};
        this.files = Object.values(request.files);
        this.totalSize = this.files.reduce((sum, f) => sum + (f.size ?? 0), 0);
        this.received = 0;
        this.saved = []; // Gio.File of each finished file
        this.state = 'pending'; // pending, receiving, done, declined, cancelled
        this._tokens = new Map(); // fileId -> token
        this._done = new Set();
        this._uploads = new Set(); // in-flight {part, stream}

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, ANSWER_TIMEOUT_SECONDS, () => {
            this._timeoutId = 0;
            this.decline();
            return GLib.SOURCE_REMOVE;
        });
        // The sender gave up while we were still asking
        this._disconnectedId = msg.connect('disconnected', () => {
            if (this.state === 'pending')
                this._end('cancelled');
        });
    }

    /** Lets go of the request message and the answer timeout. */
    _release() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        if (this._disconnectedId)
            this._msg?.disconnect(this._disconnectedId);
        this._disconnectedId = 0;
        this._msg = null;
    }

    _answer(status, body) {
        const msg = this._msg;
        this._release();
        this._device._respond(msg, status, body);
        msg.unpause();
    }

    accept() {
        if (this.state !== 'pending')
            return;
        this.state = 'receiving';
        for (const f of this.files)
            this._tokens.set(f.id, GLib.uuid_string_random());
        this._answer(200, {sessionId: this.id, files: Object.fromEntries(this._tokens)});
        this._device.emit('session-changed', this);
    }

    decline() {
        if (this.state !== 'pending')
            return;
        this._answer(403, {message: 'Declined'});
        this._end('declined');
    }

    /** Stops a running transfer from this side. */
    cancel() {
        if (this.state === 'pending')
            this.decline();
        else if (this.state === 'receiving')
            this._end('cancelled');
    }

    checkToken(fileId, token) {
        return this.state === 'receiving' && !!token && this._tokens.get(fileId) === token && !this._done.has(fileId);
    }

    fileById(id) {
        return this.files.find(f => f.id === id);
    }

    _fileDone(fileId, file) {
        this._done.add(fileId);
        this.saved.push(file);
        if (this._done.size === this._tokens.size)
            this._end('done');
        else
            this._device.emit('session-changed', this);
    }

    _end(state) {
        this._release();
        this.state = state;
        for (const upload of this._uploads)
            upload.abort();
        this._uploads.clear();
        if (this._device._session === this)
            this._device._session = null;
        this._device.emit('session-changed', this);
    }
}

export class LocalSend extends Signals.EventEmitter {
    constructor() {
        super();
        this.identity = null;
        this.receiving = false;
        this._peers = new Map(); // fingerprint -> peer
        this._session = null; // the IncomingSession in progress
        this._http = new Soup.Session({timeout: 0, idle_timeout: 30});
        this._init().catch(e => {
            console.warn(`gnotch: LocalSend: ${e.message}`);
            this.emit('state-changed');
        });
    }

    async _init() {
        this.identity = await loadIdentity();
        if (this._destroyed)
            return;
        this._startServer();
        this._startMulticast();
        this.emit('state-changed');
        this.announce();
    }

    get ready() {
        return !!this.identity;
    }

    get peers() {
        const now = Date.now();
        return [...this._peers.values()]
            .filter(p => now - p.seen < PEER_TTL_MS)
            .sort((a, b) => a.alias.localeCompare(b.alias));
    }

    get _info() {
        return {
            alias: this.identity.alias,
            version: '2.1',
            deviceModel: 'GNOME',
            deviceType: 'desktop',
            fingerprint: this.identity.fingerprint,
            port: this.identity.port,
            protocol: 'https',
            download: false,
        };
    }

    // ---- server ----

    _startServer() {
        this._server = new Soup.Server({tls_certificate: this.identity.certificate});
        this._server.connect('request-started', (_s, msg) => this._onRequestStarted(msg));
        this._server.add_handler(`${API}/register`, (_s, msg) => {
            const info = readJson(msg.get_request_body().flatten().get_data());
            if (info)
                this._addPeer(info, msg.get_remote_host());
            this._respond(msg, 200, this._info);
        });
        this._server.add_handler(`${API}/info`, (_s, msg) => this._respond(msg, 200, this._info));
        this._server.add_handler(`${API}/prepare-upload`, (_s, msg) => this._onPrepareUpload(msg));
        this._server.add_handler(`${API}/upload`, (_s, msg, _path, query) => this._onUploadDone(msg, query));
        this._server.add_handler(`${API}/cancel`, (_s, msg, _path, query) => {
            if (this._session && this._session.id === query?.sessionId)
                this._session._end('cancelled');
            this._respond(msg, 200, {});
        });
        this._server.add_handler(null, (_s, msg) => this._respond(msg, 404, {message: 'Not found'}));
        this._listen();
    }

    /** Binds the LocalSend port; while the app holds it, retries every so often. */
    _listen() {
        try {
            this._server.listen_all(this.identity.port,
                Soup.ServerListenOptions.IPV4_ONLY | Soup.ServerListenOptions.HTTPS);
            this._setReceiving(true);
        } catch (e) {
            if (this.receiving !== false || !this._retryId)
                console.warn(`gnotch: LocalSend can't receive (${e.message}); is the LocalSend app running?`);
            this._setReceiving(false);
            this._retryId ??= GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RETRY_BIND_SECONDS, () => {
                this._listen();
                if (!this.receiving)
                    return GLib.SOURCE_CONTINUE;
                this._retryId = null;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _setReceiving(receiving) {
        if (receiving === this.receiving)
            return;
        this.receiving = receiving;
        this.emit('state-changed');
    }

    _respond(msg, status, body) {
        msg.set_status(status, null);
        msg.set_response('application/json', Soup.MemoryUse.COPY, encoder.encode(JSON.stringify(body)));
    }

    _onPrepareUpload(msg) {
        const request = readJson(msg.get_request_body().flatten().get_data());
        const files = Object.values(request?.files ?? {});
        if (!request?.info?.alias || !files.length) {
            this._respond(msg, 400, {message: 'Invalid body'});
            return;
        }
        const ip = msg.get_remote_host();
        this._addPeer(request.info, ip);

        // A text message comes as one text file carrying its preview
        if (files.length === 1 && files[0].fileType?.startsWith('text/') && typeof files[0].preview === 'string') {
            this.emit('message', {sender: {...request.info, ip}, text: files[0].preview});
            msg.set_status(204, null);
            return;
        }
        if (this._session) {
            this._respond(msg, 409, {message: 'Blocked by another session'});
            return;
        }
        // Hold the answer until the person decides
        msg.pause();
        this._session = new IncomingSession(this, msg, request, ip);
        this.emit('request', this._session);
    }

    // Upload bodies are streamed to disk chunk by chunk instead of held in memory
    _onRequestStarted(msg) {
        msg.connect('got-headers', () => {
            if (msg.get_method() !== 'POST' || msg.get_uri().get_path() !== `${API}/upload`)
                return;
            const query = Object.fromEntries((msg.get_uri().get_query() ?? '').split('&')
                .filter(Boolean).map(kv => kv.split('=').map(decodeURIComponent)));
            const session = this._session;
            if (session?.id !== query.sessionId || !session.checkToken(query.fileId, query.token))
                return; // the handler answers 403
            msg.get_request_body().set_accumulate(false);
            this._startUpload(msg, session, session.fileById(query.fileId));
        });
    }

    _startUpload(msg, session, info) {
        const target = Gio.File.new_for_path(GLib.build_filenamev([this.identity.destination,
            safeRelativePath(info.fileName)]));
        const part = target.get_parent().get_child(`${target.get_basename()}.part`);
        const upload = {info, target, part, stream: null, failed: false, writing: Promise.resolve()};
        upload.abort = () => {
            upload.failed = true;
            upload.writing.finally(() => {
                upload.stream?.close(null);
                part.delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
            });
        };
        msg._gnotchUpload = upload;
        session._uploads.add(upload);
        try {
            target.get_parent().make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                upload.failed = true;
        }
        try {
            upload.stream = part.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.debug(`gnotch: LocalSend: can't write ${part.get_path()}: ${e.message}`);
            upload.failed = true;
        }

        msg.connect('got-chunk', (_m, chunk) => {
            if (upload.failed)
                return;
            // Back-pressure: no more chunks until this one is on disk
            msg.pause();
            upload.writing = this._writeAll(upload.stream, chunk).then(() => {
                session.received += chunk.get_size();
                this.emit('session-changed', session);
            }).catch(e => {
                console.debug(`gnotch: LocalSend: writing ${info.fileName}: ${e.message}`);
                upload.failed = true;
            }).finally(() => msg.unpause());
        });
        msg.connect('disconnected', () => {
            if (session._uploads.has(upload) && !upload.finished) {
                session._uploads.delete(upload);
                upload.abort();
            }
        });
    }

    async _writeAll(stream, bytes) {
        let data = bytes;
        while (data.get_size() > 0) {
            const written = await stream.write_bytes_async(data, GLib.PRIORITY_DEFAULT, null);
            if (written >= data.get_size())
                break;
            data = GLib.Bytes.new_from_bytes(data, written, data.get_size() - written);
        }
    }

    /** The upload body has fully arrived: finish the file, then answer. */
    _onUploadDone(msg, query) {
        const upload = msg._gnotchUpload;
        const session = this._session;
        if (!upload || session?.id !== query?.sessionId) {
            this._respond(msg, 403, {message: 'Invalid token'});
            return;
        }
        msg.pause();
        upload.writing.then(async () => {
            if (upload.failed)
                throw new Error('write failed');
            await upload.stream.close_async(GLib.PRIORITY_DEFAULT, null);
            const target = uniqueFile(upload.target);
            await upload.part.move_async(target, Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT, null, null);
            upload.finished = true;
            session._uploads.delete(upload);
            this._respond(msg, 200, {});
            session._fileDone(upload.info.id, target);
        }).catch(e => {
            console.debug(`gnotch: LocalSend: saving ${upload.info.fileName}: ${e.message}`);
            upload.abort();
            this._respond(msg, 500, {message: 'Could not save the file'});
        }).finally(() => msg.unpause());
    }

    // ---- discovery ----

    _startMulticast() {
        try {
            this._group = Gio.InetSocketAddress.new_from_string(MULTICAST_GROUP, DEFAULT_PORT);
            this._socket = Gio.Socket.new(Gio.SocketFamily.IPV4, Gio.SocketType.DATAGRAM, Gio.SocketProtocol.UDP);
            // allow_reuse: share the port with the LocalSend app (SO_REUSEADDR/SO_REUSEPORT)
            this._socket.bind(Gio.InetSocketAddress.new(Gio.InetAddress.new_any(Gio.SocketFamily.IPV4), DEFAULT_PORT), true);
            this._socket.join_multicast_group(this._group.address, false, null);
            this._sourceId = GLibUnix.fd_add_full(GLib.PRIORITY_DEFAULT, this._socket.fd, GLib.IOCondition.IN, () => {
                this._onDatagram();
                return GLib.SOURCE_CONTINUE;
            });
        } catch (e) {
            console.warn(`gnotch: LocalSend multicast: ${e.message}`);
            this._socket = null;
        }
    }

    _onDatagram() {
        let bytes, address;
        try {
            [bytes, address] = this._socket.receive_bytes_from(65535, 0, null);
        } catch {
            return;
        }
        const info = readJson(bytes.get_data());
        if (typeof info?.fingerprint !== 'string')
            return;
        const ip = address.address.to_string();
        if (!this._addPeer(info, ip) || !info.announce)
            return;
        // Answer an announce: register with the peer, or by UDP if that fails
        this._post(this._url({...info, ip}, '/register'), this._info, null)
            .catch(() => this._sendDatagram({...this._info, announce: false}));
    }

    /** Asks every LocalSend device on the network to say hello. */
    announce() {
        if (!this.identity)
            return;
        this._sendDatagram({...this._info, announce: true});
        // Re-register with peers we already know (catches missed multicast replies)
        for (const peer of this.peers)
            this._post(this._url(peer, '/register'), this._info, null).catch(() => {});
    }

    _sendDatagram(body) {
        try {
            this._socket?.send_to(this._group, encoder.encode(JSON.stringify(body)), null);
        } catch (e) {
            console.debug(`gnotch: LocalSend announce: ${e.message}`);
        }
    }

    /** @returns {boolean} whether the info is from another device */
    _addPeer(info, ip) {
        // Our own fingerprint is also the LocalSend app's: skip both
        if (!ip || typeof info?.alias !== 'string' || info.fingerprint === this.identity?.fingerprint)
            return false;
        const peer = {
            alias: info.alias,
            deviceModel: info.deviceModel ?? null,
            deviceType: info.deviceType ?? 'desktop',
            fingerprint: info.fingerprint,
            port: info.port ?? DEFAULT_PORT,
            protocol: info.protocol === 'http' ? 'http' : 'https',
            ip,
            seen: Date.now(),
        };
        const known = this._peers.has(peer.fingerprint);
        this._peers.set(peer.fingerprint, peer);
        if (!known)
            this.emit('peers-changed');
        return true;
    }

    // ---- sending ----

    _url(peer, path, query = {}) {
        const params = Object.entries(query)
            .filter(([, v]) => v !== undefined && v !== null && v !== '')
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        return `${peer.protocol}://${peer.ip}:${peer.port}${API}${path}${params ? `?${params}` : ''}`;
    }

    _message(url) {
        const msg = Soup.Message.new('POST', url);
        // LocalSend devices use self-signed certificates and want ours (mutual TLS)
        msg.connect('accept-certificate', () => true);
        msg.set_tls_client_certificate(this.identity.certificate);
        return msg;
    }

    async _post(url, body, cancellable) {
        for (let attempt = 1; ; attempt++) {
            const msg = this._message(url);
            if (body)
                msg.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(JSON.stringify(body))));
            try {
                const bytes = await this._http.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
                const data = bytes.get_data();
                return [msg.get_status(), data?.length ? readJson(data) : null];
            } catch (e) {
                // A handshake now and then fails (the certificate check can land on
                // a worker thread GJS refuses); nothing was sent yet, so try again
                if (!e.matches?.(Gio.TlsError, e.code) || attempt >= TLS_RETRIES)
                    throw e;
            }
        }
    }

    /**
     * Sends files to a peer; resolves once the peer has them all.
     *
     * @param {object} peer - one of this.peers
     * @param {Gio.File[]} files
     * @param {object} opts
     * @param {Gio.Cancellable} [opts.cancellable]
     * @param {string} [opts.pin]
     * @param {(fraction: number) => void} [opts.onProgress]
     * @param {() => void} [opts.onAccepted] - the peer accepted; bytes start flowing
     */
    async send(peer, files, {cancellable = null, pin, onProgress, onAccepted} = {}) {
        try {
            await this._send(peer, files, {cancellable, pin, onProgress, onAccepted});
        } catch (e) {
            if (cancellable?.is_cancelled())
                throw e;
            console.debug(`gnotch: LocalSend: sending to ${peer.alias} (${peer.ip}:${peer.port}): ${e.message}`);
            throw e instanceof LocalSendError ? e : new LocalSendError('failed', e.message);
        }
    }

    async _send(peer, files, {cancellable, pin, onProgress, onAccepted}) {
        const attrs = 'standard::size,standard::content-type,standard::display-name';
        const entries = await Promise.all(files.map(async (file, i) => {
            const info = await file.query_info_async(attrs, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
            return {
                file,
                id: `${GLib.uuid_string_random()}-${i}`,
                fileName: info.get_display_name(),
                size: info.get_size(),
                fileType: Gio.content_type_get_mime_type(info.get_content_type() ?? '') ?? 'application/octet-stream',
            };
        }));

        const body = {
            info: this._info,
            files: Object.fromEntries(entries.map(e => [e.id, {
                id: e.id, fileName: e.fileName, size: e.size, fileType: e.fileType, sha256: null, preview: null,
            }])),
        };
        // Waits until the person on the other side accepts
        const [status, json] = await this._post(this._url(peer, '/prepare-upload', {pin}), body, cancellable);
        switch (status) {
        case 200:
            break;
        case 204:
            return; // nothing to transfer
        case 401:
            throw new LocalSendError('pin', pin ? 'Wrong PIN' : 'PIN required');
        case 403:
            throw new LocalSendError('declined', `${peer.alias} declined`);
        case 409:
        case 429:
            throw new LocalSendError('busy', `${peer.alias} is busy`);
        default:
            throw new LocalSendError('failed', `${peer.alias} answered ${status}`);
        }
        const {sessionId, files: tokens} = json ?? {};
        if (!sessionId || !tokens)
            throw new LocalSendError('failed', 'Unexpected answer');
        onAccepted?.();

        const total = Math.max(1, entries.reduce((sum, e) => sum + e.size, 0));
        let sent = 0;
        try {
            for (const e of entries) {
                if (!tokens[e.id])
                    continue; // the peer skipped this one
                const msg = this._message(this._url(peer, '/upload', {sessionId, fileId: e.id, token: tokens[e.id]}));
                const stream = await e.file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
                msg.set_request_body(e.fileType, stream, e.size);
                msg.connect('wrote-body-data', (_m, chunk) => {
                    sent += chunk;
                    onProgress?.(Math.min(1, sent / total));
                });
                await this._http.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
                if (msg.get_status() !== 200)
                    throw new LocalSendError('failed', `Upload of ${e.fileName} failed (${msg.get_status()})`);
            }
        } catch (e) {
            if (cancellable?.is_cancelled())
                this._post(this._url(peer, '/cancel', {sessionId}), null, null).catch(() => {});
            throw e;
        }
    }

    destroy() {
        this._destroyed = true;
        this._session?.cancel();
        if (this._retryId)
            GLib.source_remove(this._retryId);
        this._retryId = null;
        if (this._sourceId)
            GLib.source_remove(this._sourceId);
        this._sourceId = 0;
        this._socket?.close();
        this._socket = null;
        this._server?.disconnect();
        this._server = null;
        this._http.abort();
        this._peers.clear();
    }
}
