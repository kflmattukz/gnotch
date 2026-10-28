import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';
import UPower from 'gi://UPowerGlib';

import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

import * as Anim from '../anim.js';

const DeviceProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.freedesktop.UPower.Device'));

const LOW_LEVELS = [20, 10, 5];

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

        // Layers: outer Bin (shown/hidden by the notch) > breathing Bin > icon/label (swaps)
        this._miniIcon = new St.Icon({icon_size: 16, style_class: 'gnotch-battery-icon'});
        this._miniLabel = new St.Label({style_class: 'gnotch-battery-mini', y_align: Clutter.ActorAlign.CENTER});
        this._iconGlow = new St.Bin({child: this._miniIcon});
        this._labelGlow = new St.Bin({child: this._miniLabel, y_align: Clutter.ActorAlign.CENTER});
        this.compactLeft = new St.Bin({child: this._iconGlow});
        this.compactRight = new St.Bin({child: this._labelGlow, y_align: Clutter.ActorAlign.CENTER});

        // Home tile: icon on top, percentage + detail + level bar at the bottom
        this._tile = new St.BoxLayout({
            style_class: 'gnotch-tile gnotch-battery',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this.tiles = [this._tile];
        this._icon = new St.Icon({style_class: 'gnotch-tile-icon', icon_size: 18, x_align: Clutter.ActorAlign.START});
        this._percent = new St.Label({style_class: 'gnotch-tile-title'});
        this._detail = new St.Label({style_class: 'gnotch-tile-subtitle'});
        this._detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        // Level bar; the fill is scaled horizontally so it can glide
        this._level = new St.Widget({
            style_class: 'gnotch-level',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        this._levelFill = new St.Widget({style_class: 'gnotch-level-fill', x_expand: true, y_expand: true});
        this._levelFill.set_pivot_point(0, 0.5);
        this._levelFill.scale_x = 0;
        this._level.add_child(this._levelFill);

        this._tile.add_child(this._icon);
        this._tile.add_child(new St.Widget({y_expand: true}));
        this._tile.add_child(this._percent);
        this._tile.add_child(this._detail);
        this._tile.add_child(this._level);
        this._tile.visible = false;

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
        Anim.swapIcon(this._icon, {gicon});
        Anim.swapIcon(this._miniIcon, {gicon});
        Anim.swapText(this._percent, `${percent}%`);
        Anim.swapText(this._miniLabel, `${percent}%`);
        this._percentValue = percent;
        this._fillLevel(false);

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
        Anim.swapText(this._detail, detail);

        const low = percent <= LOW_LEVELS[0] && !this._charging;
        const charging = this._charging;
        const state = low ? ' low' : charging ? ' charging' : '';
        this._miniLabel.style_class = `gnotch-battery-mini${state}`;
        this._miniIcon.style_class = `gnotch-battery-icon${state}`;
        this._tile.style_class = `gnotch-tile gnotch-battery${state}`;

        // Charging glows gently; low battery pulses faster
        Anim.breathe(this._iconGlow, p.State === UPower.DeviceState.CHARGING, {low: 120, duration: 1300});
        Anim.breathe(this._labelGlow, low, {low: 90, duration: 700});

        // Peek when plugged in/unplugged and when crossing low levels
        if (this._lastState !== null && charging !== this._lastState) {
            this._notch.peek({
                gicon,
                title: charging ? 'Charging' : 'On battery',
                body: `${percent}% · ${detail}`,
            });
        }
        this._lastState = charging;

        if (charging) {
            this._lastLowLevel = 100;
        } else {
            const level = LOW_LEVELS.findLast(l => percent <= l);
            if (level !== undefined && level < this._lastLowLevel) {
                this._lastLowLevel = level;
                this._notch.peek({gicon, title: 'Battery low', body: `${percent}% remaining`});
            }
        }

        this._notch.updateCompact();
    }

    /** Called when the Home tab appears: the bar fills up from empty. */
    onShown() {
        this._fillLevel(true);
    }

    _fillLevel(fromEmpty) {
        if (this._percentValue === undefined)
            return;
        if (fromEmpty)
            this._levelFill.scale_x = 0;
        this._levelFill.ease({
            scale_x: this._percentValue / 100,
            delay: fromEmpty ? 260 : 0,
            duration: fromEmpty ? 900 : 600,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
        });
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
