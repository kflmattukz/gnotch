import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import UPower from 'gi://UPowerGlib';

import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';
import {QuickToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import * as Anim from '../anim.js';

const DeviceProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.freedesktop.UPower.Device'));

const LOW_LEVELS = [20, 10, 5];
const TIME_LEFT_WARN_S = 3600; // smart info: once per discharge under this

function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

export class BatteryWidget {
    constructor(notch) {
        this._notch = notch;
        this._lastState = null;
        this._lastLowLevel = 100;
        this._warnedTime = false;

        // Layers: outer Bin (shown/hidden by the notch) > breathing Bin > icon/label (swaps)
        this._miniIcon = new St.Icon({icon_size: 16, style_class: 'gnotch-battery-icon'});
        this._miniLabel = new St.Label({style_class: 'gnotch-battery-mini', y_align: Clutter.ActorAlign.CENTER});
        this._iconGlow = new St.Bin({child: this._miniIcon});
        this._labelGlow = new St.Bin({child: this._miniLabel, y_align: Clutter.ActorAlign.CENTER});
        this.compactLeft = new St.Bin({child: this._iconGlow});
        this.compactRight = new St.Bin({child: this._labelGlow, y_align: Clutter.ActorAlign.CENTER});

        // Home tile, like Shell's own power toggle: percentage, time left, opens Power settings
        this._tile = new QuickToggle({style_class: 'quick-toggle button gnotch-battery', visible: false});
        this._tile.connect('clicked', () => {
            this._notch.collapse();
            Shell.AppSystem.get_default().lookup_app('gnome-power-panel.desktop')?.activate();
        });
        this.tiles = [this._tile];

        this._proxy = new DeviceProxy(Gio.DBus.system, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice', (proxy, error) => {
                if (error) {
                    console.warn(`gnotch: UPower: ${error.message}`);
                    return;
                }
                this._proxy.connectObject('g-properties-changed', () => this._sync(), this);
                this._sync();
            });
    }

    get _present() {
        return !!this._proxy?.IsPresent;
    }

    get _charging() {
        const state = this._proxy?.State;
        return state === UPower.DeviceState.CHARGING ||
            state === UPower.DeviceState.FULLY_CHARGED ||
            state === UPower.DeviceState.PENDING_CHARGE;
    }

    _iconName() {
        const p = this._proxy;
        const fill = 10 * Math.floor(p.Percentage / 10);
        if (p.State === UPower.DeviceState.FULLY_CHARGED)
            return 'battery-level-100-charged-symbolic';
        if (p.State === UPower.DeviceState.CHARGING)
            return `battery-level-${fill}-charging-symbolic`;
        return `battery-level-${fill}-symbolic`;
    }

    _sync() {
        const p = this._proxy;
        this._tile.visible = this._present;
        if (!this._present) {
            this._notch.updateCompact();
            return;
        }

        const percent = Math.round(p.Percentage);
        const iconName = this._iconName();
        const gicon = new Gio.ThemedIcon({name: iconName});
        this._tile.set({gicon, title: `${percent} %`});
        Anim.swapIcon(this._miniIcon, {gicon});
        Anim.swapText(this._miniLabel, `${percent}%`);

        let detail;
        switch (p.State) {
        case UPower.DeviceState.CHARGING:
            detail = p.TimeToFull > 0 ? `Charging · ${formatDuration(p.TimeToFull)} until full` : 'Charging';
            break;
        case UPower.DeviceState.FULLY_CHARGED:
            detail = 'Fully charged';
            break;
        case UPower.DeviceState.PENDING_CHARGE:
            detail = 'Plugged in, not charging';
            break;
        default:
            detail = p.TimeToEmpty > 0 ? `${formatDuration(p.TimeToEmpty)} remaining` : 'On battery';
        }
        this._tile.subtitle = detail;

        const low = percent <= LOW_LEVELS[0] && !this._charging;
        const charging = this._charging;
        const state = low ? ' low' : charging ? ' charging' : '';
        this._miniLabel.style_class = `gnotch-battery-mini${state}`;
        this._miniIcon.style_class = `gnotch-battery-icon${state}`;
        this._tile.style_class = `quick-toggle button gnotch-battery${state}`;

        // Charging glows gently; low battery pulses faster
        Anim.breathe(this._iconGlow, p.State === UPower.DeviceState.CHARGING, {low: 120, duration: 1300});
        Anim.breathe(this._labelGlow, low, {low: 90, duration: 700});

        // Peek when plugged in/unplugged and when crossing low levels
        if (this._lastState !== null && charging !== this._lastState) {
            this._notch.peek({
                gicon,
                title: charging ? 'Charging' : 'On battery',
                body: `${percent}% · ${detail}`,
                // GNOME's success green, as the charging icon
                glowColor: charging ? '#2ec27e' : null,
            });
        }
        this._lastState = charging;

        if (charging) {
            this._lastLowLevel = 100;
            this._warnedTime = false;
        } else {
            if (!this._warnedTime && p.TimeToEmpty > 0 && p.TimeToEmpty < TIME_LEFT_WARN_S &&
                this._notch.settings.get_boolean('smart-info')) {
                this._warnedTime = true;
                const at = new Date(Date.now() + p.TimeToEmpty * 1000)
                    .toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});
                this._notch.peek({gicon, title: `Battery runs out ~${at}`, body: `${formatDuration(p.TimeToEmpty)} left`, widget: this});
            }
            const level = LOW_LEVELS.findLast(l => percent <= l);
            if (level !== undefined && level < this._lastLowLevel) {
                this._lastLowLevel = level;
                this._notch.peek({gicon, title: 'Battery low', body: `${percent}% remaining`, glowColor: '#f66151'});
            }
        }

        this._notch.updateCompact();
    }

    wantsCompact() {
        if (!this._present)
            return false;
        return this._proxy.State === UPower.DeviceState.CHARGING ||
            (!this._charging && this._proxy.Percentage <= LOW_LEVELS[0]);
    }

    get showClockInCompact() {
        return true;
    }

    destroy() {
        this._proxy?.disconnectObject(this);
        this._proxy = null;
    }
}
