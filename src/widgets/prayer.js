import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {QuickToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import * as Anim from '../anim.js';
import {computeTimes, PRAYERS, PRAYER_NAMES} from '../praytimes.js';

const TICK_SECONDS = 15;
const ALERT_WINDOW_MS = 90 * 1000; // a prayer alert still shows this long after its time
const PRAYER_PEEK_MS = 8000;
const ICON = 'daytime-sunrise-symbolic';

function formatIn(ms) {
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export class PrayerWidget {
    constructor(notch) {
        this._notch = notch;
        this._settings = notch.settings;
        this.tabIcon = ICON;
        this._fired = new Set(); // "<day>:<prayer>:<kind>" alerts already shown
        this._cache = null;
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

        this.page = new St.BoxLayout({
            style_class: 'gnotch-page',
            orientation: Clutter.Orientation.VERTICAL,
        });
        const header = new St.BoxLayout({style_class: 'gnotch-page-header'});
        header.add_child(new St.Label({text: 'Prayer times', style_class: 'gnotch-page-title', x_expand: true}));
        this._nextLabel = new St.Label({style_class: 'gnotch-dim'});
        header.add_child(this._nextLabel);
        this.page.add_child(header);

        this._list = new St.BoxLayout({style_class: 'gnotch-prayer-list', x_expand: true});
        this._rows = new Map();
        for (const p of PRAYERS) {
            const row = new St.BoxLayout({
                style_class: 'gnotch-prayer',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            const name = new St.Label({text: PRAYER_NAMES[p], style_class: 'gnotch-prayer-name', x_align: Clutter.ActorAlign.CENTER});
            const time = new St.Label({style_class: 'gnotch-prayer-time', x_align: Clutter.ActorAlign.CENTER});
            row.add_child(name);
            row.add_child(time);
            this._list.add_child(row);
            this._rows.set(p, {row, time});
        }
        this.page.add_child(this._list);

        // Compact pill while a prayer is near: icon left, "Asr · 8 min" right
        this._miniIcon = new St.Icon({icon_name: ICON, icon_size: 16, style_class: 'gnotch-prayer-icon'});
        this._miniLabel = new St.Label({style_class: 'gnotch-prayer-mini', y_align: Clutter.ActorAlign.CENTER});
        this.compactLeft = new St.Bin({child: this._miniIcon});
        this.compactRight = new St.Bin({child: this._miniLabel, y_align: Clutter.ActorAlign.CENTER});
        this.bubble = new St.Icon({icon_name: ICON, icon_size: 16, style_class: 'gnotch-prayer-icon'});

        this._tile = new QuickToggle({title: 'Prayer', icon_name: ICON});
        this._tile.connect('clicked', () => this._notch.selectWidget(this));
        this.tiles = [this._tile];

        this._settings.connectObject('changed', (_s, key) => {
            if (key.startsWith('prayer-')) {
                this._cache = null;
                this._tick();
            }
        }, this);
        this._interface.connectObject('changed::clock-format', () => this._tick(), this);

        // Timestamps already past when we start don't alert
        this._tick({silent: true});
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _format(date) {
        const twelve = this._interface.get_string('clock-format') === '12h';
        return GLib.DateTime.new_from_unix_local(Math.floor(date.getTime() / 1000))
            .format(twelve ? '%l:%M %p' : '%H:%M').trim();
    }

    /** Times for the day of `date`, cached per day. */
    _times(date) {
        const day = date.toDateString();
        if (this._cache?.[day])
            return this._cache[day];
        const times = computeTimes(date,
            this._settings.get_double('prayer-latitude'),
            this._settings.get_double('prayer-longitude'), {
                method: this._settings.get_string('prayer-method'),
                asr: this._settings.get_string('prayer-asr'),
                offsets: this._settings.get_value('prayer-offsets').deepUnpack(),
            });
        // Keep today and tomorrow only
        this._cache = {...Object.fromEntries(Object.entries(this._cache ?? {}).slice(-1)), [day]: times};
        return times;
    }

    _next(now) {
        const today = this._times(now);
        const p = PRAYERS.find(name => today[name] > now);
        if (p)
            return {prayer: p, time: today[p]};
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        return {prayer: 'fajr', time: this._times(tomorrow).fajr};
    }

    _tick({silent = false} = {}) {
        const now = new Date();
        const today = this._times(now);
        const day = now.toDateString();
        const lead = this._settings.get_uint('prayer-reminder-min') * 60000;

        for (const p of PRAYERS) {
            const t = today[p];
            const until = t - now;
            // Reminder before (not for sunrise), then the prayer itself
            if (p !== 'sunrise' && lead > 0 && until > 0 && until <= lead)
                this._alert(`${day}:${p}:remind`, silent, {
                    title: `${PRAYER_NAMES[p]} in ${formatIn(until)}`,
                    body: this._format(t),
                });
            if (until <= 0 && -until < ALERT_WINDOW_MS)
                this._alert(`${day}:${p}:time`, silent, {
                    title: PRAYER_NAMES[p],
                    body: p === 'sunrise' ? `Sunrise · ${this._format(t)}` : `It's time for ${PRAYER_NAMES[p]} · ${this._format(t)}`,
                    urgent: true,
                    duration: PRAYER_PEEK_MS,
                });
        }
        // Forget yesterday's alerts
        for (const key of this._fired) {
            if (!key.startsWith(day))
                this._fired.delete(key);
        }

        const next = this._next(now);
        const until = next.time - now;
        const nextName = PRAYER_NAMES[next.prayer];
        this._nextLabel.text = `${nextName} in ${formatIn(until)}`;
        for (const [p, {row, time}] of this._rows) {
            time.text = this._format(today[p]);
            row.style_class = `gnotch-prayer${p === next.prayer ? ' next' : today[p] < now ? ' past' : ''}`;
        }
        this._tile.title = `Next: ${nextName}`;
        this._tile.subtitle = `${this._format(next.time)} · in ${formatIn(until)}`;

        const near = next.prayer !== 'sunrise' && lead > 0 && until <= lead;
        const mini = `${nextName} · ${formatIn(until)}`;
        if (this._miniLabel.text !== mini)
            Anim.swapText(this._miniLabel, mini);
        if (near !== this._near) {
            this._near = near;
            this._notch.updateCompact();
        }
    }

    _alert(key, silent, peek) {
        if (this._fired.has(key))
            return;
        this._fired.add(key);
        if (!silent)
            this._notch.peek({iconName: ICON, ...peek});
    }

    onShown() {
        this._tick();
        Anim.stagger(this._list.get_children(), {dy: 6, delay: 100, step: 25, duration: 250});
    }

    wantsCompact() {
        return !!this._near;
    }

    get showClockInCompact() {
        return true;
    }

    destroy() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        this._settings.disconnectObject(this);
        this._interface.disconnectObject(this);
    }
}
