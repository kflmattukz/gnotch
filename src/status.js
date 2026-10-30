// System status glyphs for the pill that no widget owns: an orange dot
// while an app records from the microphone (on the left, like a privacy
// light) and a muted speaker while the output is muted.

import Clutter from 'gi://Clutter';
import Gvc from 'gi://Gvc';
import St from 'gi://St';

import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

// Same as the Shell's input indicator: these show input levels, they don't record
const SKIPPED_APPS = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];

export class SystemStatus {
    constructor(notch) {
        this._notch = notch;
        this._mic = new St.Widget({style_class: 'gnotch-status-mic', y_align: Clutter.ActorAlign.CENTER});
        this._muted = new St.Icon({
            icon_name: 'audio-volume-muted-symbolic',
            icon_size: 14,
            style_class: 'gnotch-status-icon',
        });

        this._control = getMixerControl();
        this._control.connectObject(
            'stream-added', () => this._sync(),
            'stream-removed', () => this._sync(),
            'stream-changed', () => this._sync(),
            'default-sink-changed', () => this._watchSink(),
            this);
        this._watchSink();
    }

    _watchSink() {
        this._sink?.disconnectObject(this);
        this._sink = this._control.get_default_sink();
        this._sink?.connectObject('notify::is-muted', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const recording =
            this._control.get_sources().some(s => s.state === Gvc.MixerStreamState.RUNNING) &&
            this._control.get_source_outputs().some(o => !SKIPPED_APPS.includes(o.get_application_id()));
        this._notch.setStatus(this._mic, recording, {side: 'left'});
        this._notch.setStatus(this._muted, !!this._sink?.is_muted);
    }

    destroy() {
        this._control.disconnectObject(this);
        this._sink?.disconnectObject(this);
        this._sink = null;
    }
}
