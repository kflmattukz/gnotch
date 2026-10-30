import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Islands} from './src/islands.js';
import {Notch} from './src/notch.js';

export default class GnotchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settings.connectObject('changed::enabled-widgets', () => this._rebuild(), this);
        this._notch = new Notch(this._settings, this.path);
        this._islands = new Islands(this._settings);
    }

    disable() {
        this._islands.destroy();
        this._islands = null;
        this._settings.disconnectObject(this);
        this._settings = null;
        this._notch?.destroy();
        this._notch = null;
    }

    _rebuild() {
        this._notch?.destroy();
        this._notch = new Notch(this._settings, this.path);
    }
}
