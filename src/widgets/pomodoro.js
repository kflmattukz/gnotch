import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';
import {QuickToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import * as Anim from '../anim.js';

const PHASES = {
    focus: {title: 'Focus', key: 'pomodoro-focus-min', icon: 'alarm-symbolic'},
    short: {title: 'Short break', key: 'pomodoro-short-min', icon: 'emoji-nature-symbolic'},
    long: {title: 'Long break', key: 'pomodoro-long-min', icon: 'emoji-nature-symbolic'},
};

// Smart info: nudge after this much activity; this long away from the keyboard and mouse resets it
const SESSION_MINUTES = 90;
const IDLE_RESET_MS = 5 * 60 * 1000;

function formatClock(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class PomodoroWidget {
    constructor(notch) {
        this._notch = notch;
        this._settings = notch.settings;
        this.tabIcon = 'alarm-symbolic';
        this._phase = 'focus';
        this._round = 1;
        this._endsAt = 0; // monotonic µs; 0 while paused or idle
        this._remaining = this._length('focus'); // seconds, while paused or idle
        this._started = false;
        this._tickId = 0;

        this.page = new St.BoxLayout({
            style_class: 'gnotch-page gnotch-pomodoro',
            orientation: Clutter.Orientation.VERTICAL,
        });
        const header = new St.BoxLayout({style_class: 'gnotch-page-header'});
        this._phaseLabel = new St.Label({style_class: 'gnotch-page-title', x_expand: true});
        this._roundLabel = new St.Label({style_class: 'gnotch-dim'});
        header.add_child(this._phaseLabel);
        header.add_child(this._roundLabel);
        this.page.add_child(header);

        this._timeLabel = new St.Label({style_class: 'gnotch-pomodoro-time', x_align: Clutter.ActorAlign.CENTER});
        this.page.add_child(this._timeLabel);
        this._level = new BarLevel({style_class: 'level', x_expand: true});
        this.page.add_child(this._level);

        const controls = new St.BoxLayout({style_class: 'gnotch-media-controls', x_align: Clutter.ActorAlign.CENTER});
        this._reset = this._button('view-refresh-symbolic', () => this._resetAll());
        this._play = this._button('media-playback-start-symbolic', () => this._toggle(), 'primary');
        this._skip = this._button('media-skip-forward-symbolic', () => this._advance(false));
        [this._reset, this._play, this._skip].forEach(b => controls.add_child(b));
        this.page.add_child(controls);

        // Compact pill: phase icon on the left, countdown on the right
        this._miniIcon = new St.Icon({icon_size: 16, style_class: 'gnotch-pomodoro-icon'});
        this._iconGlow = new St.Bin({child: this._miniIcon});
        this._miniLabel = new St.Label({style_class: 'gnotch-pomodoro-mini', y_align: Clutter.ActorAlign.CENTER});
        this.compactLeft = new St.Bin({child: this._iconGlow});
        this.compactRight = new St.Bin({child: this._miniLabel, y_align: Clutter.ActorAlign.CENTER});

        this._tile = new QuickToggle({title: 'Pomodoro', icon_name: 'alarm-symbolic'});
        this._tile.connect('clicked', () => this._notch.selectWidget(this));
        this.tiles = [this._tile];

        this._settings.connectObject('changed', (_s, key) => {
            // A new length applies right away while idle
            if (key.startsWith('pomodoro-') && !this._started)
                this._remaining = this._length(this._phase);
            this._sync();
        }, this);
        this._sync();

        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._idleWatchId = this._idleMonitor.add_idle_watch(IDLE_RESET_MS, () => this._onIdle());
        this._activeWatchId = 0;
        this._sessionId = 0;
        this._startSession(); // the user is active when the extension starts
    }

    // ---- long-session break ----

    _startSession() {
        this._stopSession();
        this._sessionId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SESSION_MINUTES * 60, () => {
            this._sessionId = 0;
            if (!this._started && this._settings.get_boolean('smart-info')) {
                this._notch.peek({
                    iconName: PHASES.short.icon,
                    title: 'Time for a break',
                    body: `You've been at it for ${SESSION_MINUTES} min`,
                    widget: this,
                });
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopSession() {
        if (this._sessionId)
            GLib.source_remove(this._sessionId);
        this._sessionId = 0;
    }

    _onIdle() {
        // Away long enough: the next activity starts a fresh session
        this._stopSession();
        if (!this._activeWatchId) {
            this._activeWatchId = this._idleMonitor.add_user_active_watch(() => {
                this._activeWatchId = 0; // a user-active watch fires once
                this._startSession();
            });
        }
    }

    _button(iconName, callback, extra = '') {
        const button = new St.Button({
            style_class: `icon-button gnotch-media-button ${extra}`,
            can_focus: true,
            child: new St.Icon({icon_name: iconName}),
        });
        button.connect('clicked', callback);
        return button;
    }

    _length(phase) {
        return Math.max(1, this._settings.get_uint(PHASES[phase].key)) * 60;
    }

    get _running() {
        return this._endsAt > 0;
    }

    _secondsLeft() {
        return this._running ? (this._endsAt - GLib.get_monotonic_time()) / 1e6 : this._remaining;
    }

    _toggle() {
        if (this._running) {
            this._remaining = this._secondsLeft();
            this._endsAt = 0;
            this._stopTick();
        } else {
            this._start();
        }
        this._sync();
    }

    _start() {
        this._started = true;
        this._endsAt = GLib.get_monotonic_time() + this._remaining * 1e6;
        this._stopTick();
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (this._secondsLeft() <= 0)
                this._advance(true);
            else
                this._sync();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTick() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
    }

    /** Moves to the next phase; `finished` when the timer ran out (not skipped). */
    _advance(finished) {
        const rounds = Math.max(1, this._settings.get_uint('pomodoro-rounds'));
        const wasFocus = this._phase === 'focus';
        let next;
        if (wasFocus) {
            next = this._round >= rounds ? 'long' : 'short';
        } else {
            next = 'focus';
            this._round = this._phase === 'long' ? 1 : this._round + 1;
        }
        const wasRunning = this._running;
        this._phase = next;
        this._remaining = this._length(next);
        this._endsAt = 0;
        this._stopTick();

        if (finished) {
            const minutes = this._length(next) / 60;
            this._notch.peek({
                iconName: PHASES[next].icon,
                title: wasFocus ? 'Focus done' : 'Break over',
                body: wasFocus ? `Take a ${minutes} min break` : `Round ${this._round} · ${minutes} min focus`,
                urgent: true,
            });
            global.display.get_sound_player().play_from_theme('complete', 'Pomodoro', null);
        }
        // Skipping keeps the timer's play/pause state; a finished phase may wait for Start
        if (wasRunning && (!finished || this._settings.get_boolean('pomodoro-auto-start')))
            this._start();
        else if (finished)
            this._started = false;
        this._sync();
    }

    _resetAll() {
        this._stopTick();
        this._phase = 'focus';
        this._round = 1;
        this._endsAt = 0;
        this._started = false;
        this._remaining = this._length('focus');
        this._sync();
    }

    _sync() {
        const left = this._secondsLeft();
        const clock = formatClock(left);
        const phase = PHASES[this._phase];
        const rounds = Math.max(1, this._settings.get_uint('pomodoro-rounds'));

        this._phaseLabel.text = phase.title;
        this._roundLabel.text = `Round ${Math.min(this._round, rounds)} of ${rounds}`;
        if (this._timeLabel.text !== clock)
            Anim.swapText(this._timeLabel, clock, {dy: 4});
        this._level.value = 1 - left / this._length(this._phase);
        this._play.child.icon_name = this._running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';

        const state = this._phase === 'focus' ? 'focus' : 'break';
        this._miniIcon.icon_name = phase.icon;
        this._miniIcon.style_class = `gnotch-pomodoro-icon ${state}`;
        this._miniLabel.style_class = `gnotch-pomodoro-mini ${state}`;
        if (this._miniLabel.text !== clock)
            this._miniLabel.text = clock;
        // Paused timers breathe
        Anim.breathe(this._iconGlow, this._started && !this._running, {low: 90, duration: 900});

        this._tile.checked = this._running;
        this._tile.subtitle = this._started ? `${phase.title} · ${clock}` : 'Ready';

        const shown = this._started;
        if (shown !== this._compactWanted) {
            this._compactWanted = shown;
            this._notch.updateCompact();
        }
    }

    wantsCompact() {
        return this._started;
    }

    get showClockInCompact() {
        return true;
    }

    destroy() {
        this._stopTick();
        this._stopSession();
        this._idleMonitor.remove_watch(this._idleWatchId);
        if (this._activeWatchId)
            this._idleMonitor.remove_watch(this._activeWatchId);
        this._idleMonitor = null;
        this._settings.disconnectObject(this);
    }
}
