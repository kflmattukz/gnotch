// The Gnotch Chrome extension (chrome-extension/) connects here to let the
// notch act on WhatsApp Web: a WebSocket on 127.0.0.1 only, accepted from a
// Chrome extension origin with the pairing token from the settings. An
// extension without the token asks to pair ('pair-request'); once the user
// accepts in the notch, it receives the token ({type: 'paired', token}).
//
// Shell -> extension: {type, reqId, ...}; the extension answers
// {type: 'result', reqId, ok, data|error}. Extension -> Shell events have
// no reqId (e.g. {type: 'call', state}).

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const PATH = '/gnotch';
const REQUEST_TIMEOUT_SECONDS = 15;
const HELLO_TIMEOUT_SECONDS = 5;

export class WhatsAppBridge extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._client = null; // the paired WebSocket connection
        this._pending = new Map(); // reqId -> {resolve, reject, timeoutId}
        this._declined = new Set(); // extension origins the user said no to (this session)
        this._nextId = 1;

        // A random token on first use; the extension's options page needs it
        if (!this._settings.get_string('whatsapp-token'))
            this._settings.set_string('whatsapp-token', GLib.uuid_string_random());
        this._settings.connectObject(
            'changed::whatsapp-token', () => this._client?.close(Soup.WebsocketCloseCode.POLICY_VIOLATION, 'token changed'),
            'changed::whatsapp-port', () => this._listen(),
            this);
        this._listen();
    }

    get connected() {
        return !!this._client;
    }

    _listen() {
        this._server?.disconnect();
        this._server = new Soup.Server({});
        this._server.add_websocket_handler(PATH, null, null, (_s, msg, _path, connection) =>
            this._onConnection(msg, connection));
        try {
            // Loopback only: nothing on the network can reach it
            this._server.listen_local(this._settings.get_uint('whatsapp-port'), Soup.ServerListenOptions.IPV4_ONLY);
        } catch (e) {
            console.warn(`gnotch: WhatsApp bridge: ${e.message}`);
        }
    }

    _onConnection(msg, connection) {
        // Only a Chrome extension (web pages can open WebSockets to localhost too)
        const origin = msg.get_request_headers().get_one('Origin') ?? '';
        if (!origin.startsWith('chrome-extension://')) {
            connection.close(Soup.WebsocketCloseCode.POLICY_VIOLATION, 'not an extension');
            return;
        }
        let paired = false;
        let pairing = null; // the request shown to the user, while it waits
        let helloId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, HELLO_TIMEOUT_SECONDS, () => {
            helloId = 0;
            if (!paired && !pairing)
                connection.close(Soup.WebsocketCloseCode.POLICY_VIOLATION, 'no hello');
            return GLib.SOURCE_REMOVE;
        });
        const clearHello = () => {
            if (helloId)
                GLib.source_remove(helloId);
            helloId = 0;
        };
        const pair = () => {
            paired = true;
            clearHello();
            // A newer connection (e.g. Chrome restarted) replaces the old one
            this._client?.close(Soup.WebsocketCloseCode.NORMAL, 'replaced');
            this._client = connection;
            this.emit('connected-changed', true);
        };

        connection.connect('message', (_c, _type, bytes) => {
            let data;
            try {
                data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            } catch {
                return;
            }
            if (paired) {
                this._onMessage(data);
                return;
            }
            if (data?.type !== 'hello' || pairing)
                return;
            if (data.token && data.token === this._settings.get_string('whatsapp-token')) {
                this._sendTo(connection, {type: 'welcome'});
                pair();
                return;
            }
            // Unknown extension: ask the user once per session, then hand it the token
            if (this._declined.has(origin)) {
                connection.close(Soup.WebsocketCloseCode.POLICY_VIOLATION, 'declined');
                return;
            }
            clearHello();
            pairing = {
                origin,
                accept: () => {
                    pairing = null;
                    this._sendTo(connection, {type: 'paired', token: this._settings.get_string('whatsapp-token')});
                    pair();
                },
                decline: () => {
                    pairing = null;
                    this._declined.add(origin);
                    connection.close(Soup.WebsocketCloseCode.POLICY_VIOLATION, 'declined');
                },
            };
            this.emit('pair-request', pairing);
        });
        connection.connect('closed', () => {
            clearHello();
            if (pairing) {
                this.emit('pair-cancelled', pairing);
                pairing = null;
            }
            if (this._client !== connection)
                return;
            this._client = null;
            for (const [reqId, p] of this._pending)
                this._settle(reqId, p, false, 'disconnected');
            this.emit('connected-changed', false);
        });
    }

    _onMessage(data) {
        if (data?.type === 'result') {
            const p = this._pending.get(data.reqId);
            if (p)
                this._settle(data.reqId, p, data.ok, data.ok ? data.data : data.error);
        } else if (typeof data?.type === 'string') {
            this.emit('event', data);
        }
    }

    _settle(reqId, p, ok, value) {
        this._pending.delete(reqId);
        if (p.timeoutId)
            GLib.source_remove(p.timeoutId);
        if (ok)
            p.resolve(value);
        else
            p.reject(new Error(value ?? 'failed'));
    }

    _send(data) {
        if (this._client)
            this._sendTo(this._client, data);
    }

    _sendTo(connection, data) {
        connection.send_text(JSON.stringify(data));
    }

    /** Asks the extension to do something; resolves with its answer. */
    request(type, payload = {}) {
        if (!this._client)
            return Promise.reject(new Error('Chrome extension not connected'));
        const reqId = this._nextId++;
        return new Promise((resolve, reject) => {
            const pending = {resolve, reject};
            pending.timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_SECONDS, () => {
                pending.timeoutId = 0; // this source is finishing on its own
                this._settle(reqId, pending, false, 'no answer from Chrome');
                return GLib.SOURCE_REMOVE;
            });
            this._pending.set(reqId, pending);
            this._send({...payload, type, reqId});
        });
    }

    destroy() {
        this._settings.disconnectObject(this);
        for (const [reqId, p] of this._pending)
            this._settle(reqId, p, false, 'closed');
        this._client?.close(Soup.WebsocketCloseCode.GOING_AWAY, 'bye');
        this._client = null;
        this._server?.disconnect();
        this._server = null;
    }
}
