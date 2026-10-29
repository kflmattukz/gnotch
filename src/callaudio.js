// Notices calls in Chrome from its audio streams and measures how loud each
// side is, for the in-call voice waves.
//
// Observed with WhatsApp Web (Chrome Flatpak 156, PipeWire): Chrome records
// from the microphone ("Google Chrome input") exactly while a call is
// connected, and plays the other side through a "Google Chrome" stream that
// starts with it. Levels come from parec at a low rate: the microphone the
// call uses, and a monitor of Chrome's newest playback stream.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');

const RATE = 8000;
const CHUNK_BYTES = 640; // 40 ms of mono s16
const REFRESH_DELAY_MS = 150; // stream events come in bursts
const FLOOR_DB = -60; // silence
const RANGE_DB = 45; // FLOOR_DB + RANGE_DB is full scale for speech
const CALL_STREAM_WINDOW_MS = 6000;

function isChrome(props) {
    return props['pipewire.access.portal.app_id'] === 'com.google.Chrome' ||
        props['application.process.binary'] === 'chrome' ||
        /^Google Chrome/.test(props['application.name'] ?? '');
}

async function pactlJson(...args) {
    const proc = Gio.Subprocess.new(['pactl', '-f', 'json', ...args],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const [stdout] = await proc.communicate_utf8_async(null, null);
    return JSON.parse(stdout || '[]');
}

/** 0..1 loudness of a chunk of signed 16-bit samples. */
function level(bytes) {
    const data = bytes.get_data();
    if (!data?.length)
        return 0;
    const samples = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
    let sum = 0;
    for (const s of samples)
        sum += s * s;
    const rms = Math.sqrt(sum / samples.length) / 32768;
    const db = rms > 0 ? 20 * Math.log10(rms) : FLOOR_DB;
    return Math.min(1, Math.max(0, (db - FLOOR_DB) / RANGE_DB));
}

/** Streams raw audio from parec and reports its level per chunk. */
class Meter {
    constructor(args, onLevel) {
        this._cancellable = new Gio.Cancellable();
        try {
            this._proc = Gio.Subprocess.new(['parec', '--raw', '--format=s16le', `--rate=${RATE}`,
                '--channels=1', '--latency-msec=40', ...args],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`gnotch: call audio meter: ${e.message}`);
            return;
        }
        this._read(this._proc.get_stdout_pipe(), onLevel).catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`gnotch: call audio meter: ${e.message}`);
        });
    }

    async _read(stream, onLevel) {
        for (;;) {
            const bytes = await stream.read_bytes_async(CHUNK_BYTES, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (bytes.get_size() === 0)
                return; // parec ended
            onLevel(level(bytes));
        }
    }

    stop() {
        this._cancellable.cancel();
        this._proc?.force_exit();
        this._proc = null;
    }
}

export class CallAudio extends Signals.EventEmitter {
    constructor() {
        super();
        this.active = false;
        this._mic = null; // {source, meter}
        this._remote = null; // {input, meter}
        this._levels = {mine: 0, theirs: 0};
        this._micSince = 0;
        this._callInputs = new Set();
        this._ended = false;
        this._subscribe().catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`gnotch: call audio: ${e.message}`);
        });
        this._refreshSerial();
    }

    /** One refresh at a time; changes during one trigger another after it. */
    _refreshSerial() {
        if (this._refreshing) {
            this._dirty = true;
            return;
        }
        this._refreshing = this._refresh()
            .catch(e => console.warn(`gnotch: call audio: ${e.message}`))
            .finally(() => {
                this._refreshing = null;
                if (this._dirty && !this._destroyed) {
                    this._dirty = false;
                    this._refreshSerial();
                }
            });
    }

    // pactl subscribe prints one line per change ("Event 'new' on source-output #203")
    async _subscribe() {
        this._cancellable = new Gio.Cancellable();
        this._watcher = Gio.Subprocess.new(['pactl', 'subscribe'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const lines = new Gio.DataInputStream({base_stream: this._watcher.get_stdout_pipe()});
        for (;;) {
            const [line] = await lines.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable);
            if (line === null)
                return;
            if (/source-output|sink-input/.test(new TextDecoder().decode(line)))
                this._queueRefresh();
        }
    }

    _queueRefresh() {
        if (this._refreshId)
            return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY_MS, () => {
            this._refreshId = 0;
            this._refreshSerial();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        const [outputs, inputs] = await Promise.all([
            pactlJson('list', 'source-outputs'), pactlJson('list', 'sink-inputs')]);
        if (this._destroyed)
            return;
        const recording = outputs.filter(o => isChrome(o.properties ?? {}));
        const playing = inputs.filter(i => isChrome(i.properties ?? {}));
        const micHeld = recording.length > 0;

        // The call's playback: Chrome streams playing in the first seconds after
        // the mic opens (the ringtone can overlap the call's audio briefly).
        // Once none of them plays, the call is over, even if WhatsApp still
        // holds the mic (it can, on its "call ended" screen); later sounds
        // such as the end tone don't count. A new call needs the mic to be
        // released and taken again.
        if (!micHeld) {
            this._micSince = 0;
            this._callInputs = new Set();
            this._ended = false;
        } else {
            this._micSince ||= Date.now();
            if (Date.now() - this._micSince < CALL_STREAM_WINDOW_MS)
                playing.forEach(i => this._callInputs.add(i.index));
            const callPlaying = playing.filter(i => this._callInputs.has(i.index));
            if (this._callInputs.size && !callPlaying.length)
                this._ended = true;
        }
        const active = micHeld && !this._ended;

        if (active) {
            // The microphone Chrome records from, and the call's playback stream
            const source = recording[recording.length - 1].source;
            if (this._mic?.source !== source)
                await this._meterMic(source);
            const input = playing.filter(i => this._callInputs.has(i.index)).pop() ?? null;
            if (this._remote?.input !== input?.index)
                await this._meterRemote(input);
        } else {
            this._stopMeters();
        }
        if (active !== this.active) {
            this.active = active;
            this.emit('active-changed', active);
        }
    }

    async _meterMic(source) {
        this._mic?.meter?.stop();
        const sources = await pactlJson('list', 'sources');
        const name = sources.find(s => s.index === source)?.name;
        this._mic = {source, meter: name ? new Meter([`--device=${name}`], l => this._setLevel('mine', l)) : null};
    }

    async _meterRemote(input) {
        this._remote?.meter.stop();
        this._remote = null;
        if (!input)
            return;
        const sinks = await pactlJson('list', 'sinks');
        const monitor = sinks.find(s => s.index === input.sink)?.monitor_source;
        if (!monitor)
            return;
        this._remote = {
            input: input.index,
            meter: new Meter([`--device=${monitor}`, `--monitor-stream=${input.index}`], l => this._setLevel('theirs', l)),
        };
    }

    _setLevel(side, value) {
        this._levels[side] = value;
        this.emit('levels', this._levels);
    }

    _stopMeters() {
        this._mic?.meter?.stop();
        this._remote?.meter.stop();
        this._mic = null;
        this._remote = null;
        this._levels = {mine: 0, theirs: 0};
    }

    destroy() {
        this._destroyed = true;
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = 0;
        this._cancellable?.cancel();
        this._watcher?.force_exit();
        this._watcher = null;
        this._stopMeters();
    }
}
