import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';

import * as Anim from './anim.js';
import {Cover} from './cover.js';
import {Glass} from './glass.js';
import {Glow, glowColorFor, rgb} from './glow.js';
import {MediaWidget} from './widgets/media.js';
import {BatteryWidget} from './widgets/battery.js';
import {NetworkWidget} from './widgets/network.js';
import {CalendarWidget} from './widgets/calendar.js';
import {TodoWidget} from './widgets/todo.js';
import {NotificationsWidget} from './widgets/notifications.js';
import {DevicesWidget} from './widgets/devices.js';
import {PomodoroWidget} from './widgets/pomodoro.js';
import {PrayerWidget} from './widgets/prayer.js';
import {ShareWidget} from './widgets/share.js';
import {WhatsAppWidget} from './widgets/whatsapp.js';

const {EASE_OUT_QUAD, LINEAR} = Clutter.AnimationMode;

const COMPACT_HEIGHT = 32;
const IDLE_WIDTH = 150;
const ACTIVE_WIDTH = 280;
const PEEK_WIDTH = 400;
const PEEK_HEIGHT = 50;
// The expanded height follows the selected tab's content, within these bounds
const EXPANDED_MIN_HEIGHT = 200;
const EXPANDED_MAX_HEIGHT = 440;
const EXPANDED_PADDING = [18, 8, 18, 16]; // left, top, right, bottom (matches .gnotch-expanded)
const HOVER_BULGE = [14, 4];
const EAR = 10; // concave "shoulders" joining the screen edge
// Black tint left over the frosted glass when fully expanded. Blur my Shell's
// top bar has none, so keep it light enough for the glass to read the same
const GLASS_TINT = 0.12;
const GLASS_IN = {stiffness: 170, damping: 26};  // ζ≈1, slow dissolve into glass
const GLASS_OUT = {stiffness: 420, damping: 41}; // back to solid black quickly

// Shape springs per transition: width can bounce, height lands softer
// (vertical overshoot against the screen edge looks wrong)
const SHAPE = {
    expand: {w: Anim.Springs.BOUNCY, h: Anim.Springs.SMOOTH},
    collapse: {w: Anim.Springs.SETTLE, h: Anim.Springs.SETTLE},
    peek: {w: {stiffness: 340, damping: 30}, h: Anim.Springs.SMOOTH}, // ζ≈0.81
    compact: {w: Anim.Springs.SMOOTH, h: Anim.Springs.SETTLE},
    hover: {w: Anim.Springs.SNAPPY, h: Anim.Springs.SNAPPY},
};

// Order matters: earlier widgets win the compact pill
const WIDGETS = {
    media: MediaWidget,
    whatsapp: WhatsAppWidget,
    prayer: PrayerWidget,
    pomodoro: PomodoroWidget,
    share: ShareWidget,
    battery: BatteryWidget,
    network: NetworkWidget,
    calendar: CalendarWidget,
    todo: TodoWidget,
    notifications: NotificationsWidget,
    devices: DevicesWidget,
};

// Home tab: media card on the left, a 2-column grid of tiles from these widgets on the right
const TILE_WIDGETS = ['battery', 'network', 'todo', 'pomodoro', 'prayer'];
const OSD_DURATION_MS = 1500;

function cornerRadius(height) {
    return Math.min(32, Math.round(10 + height * 0.2));
}

export class Notch {
    constructor(settings, path) {
        this._settings = settings;
        this._path = path;
        this._state = 'compact';
        this._timeouts = new Map();
        this._peekQueue = [];
        this._grab = null;
        this._compactShown = new Map();
        this._currentTab = -1;
        this._radius = -1;

        // Outer container: pill plus the two shoulders
        this.actor = new St.Widget({style_class: 'gnotch-container'});
        this._pill = new St.Widget({
            style_class: 'gnotch',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
        });
        // Layers inside the pill: blurred wallpaper, then the black tint, then content
        this._glass = new Glass(() => this._syncGlass());
        this._tint = new St.Widget({x_expand: true, y_expand: true});
        this._pill.add_child(this._glass.actor);
        this._pill.add_child(this._tint);
        this._tintStyle = '';

        this._earLeft = this._makeEar(false);
        this._earRight = this._makeEar(true);
        this.actor.add_child(this._earLeft);
        this.actor.add_child(this._earRight);
        this.actor.add_child(this._pill);
        // The glowing edge goes on top: its halo spreads outside the pill
        this._glow = new Glow();
        this.actor.add_child(this._glow.actor);

        this._shape = new Anim.Spring(this._pill,
            {w: IDLE_WIDTH, h: COMPACT_HEIGHT, g: 0},
            v => this._applyShape(v));

        this._buildCompact();
        this._buildPeek();
        this._buildExpanded();

        const enabled = this._settings.get_strv('enabled-widgets');
        this._widgets = new Map();
        for (const [name, Widget] of Object.entries(WIDGETS)) {
            if (enabled.includes(name))
                this._widgets.set(name, new Widget(this));
        }
        this._populate();

        this._pill.connect('notify::hover', () => this._onHover());
        this._pill.connect('button-press-event', (_a, event) => {
            // The peek's own buttons (accept / decline...) don't open the notch
            if (this._peekActions.contains(global.stage.get_event_actor(event)))
                return Clutter.EVENT_PROPAGATE;
            if (this._state !== 'expanded')
                this.expand();
            return Clutter.EVENT_PROPAGATE;
        });
        this._pill.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.collapse();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        Main.layoutManager.addChrome(this.actor, {
            affectsStruts: false,
            trackFullscreen: true,
        });
        Main.layoutManager.connectObject('monitors-changed',
            () => this._applyShape(this._shape.values), this);

        this._settings.connectObject(
            'changed::hide-clock', () => this._syncClock(),
            'changed::glass-expanded', () => this._syncGlass(),
            'changed::glow-enabled', () => this._syncGlow(),
            'changed::glow-hover', () => this._syncGlow(),
            this);
        this._syncClock();
        this._syncGlow();
        // The edge lights up as the pointer approaches, anywhere on screen
        global.backend.get_cursor_tracker().connectObject('position-invalidated',
            () => this._queuePointer(), this);

        this._hookOsd();
        this._hookDnd();
        this.updateCompact();
        const [w, h] = this._targetSize();
        this._shape.set({w, h});
    }

    // ---- building ----

    _makeEar(right) {
        const ear = new St.DrawingArea({width: EAR, height: EAR});
        ear.connect('repaint', area => {
            const cr = area.get_context();
            cr.setSourceRGBA(0, 0, 0, 1);
            // Square minus a quarter circle: a concave fillet into the pill side
            if (right) {
                cr.moveTo(EAR, 0);
                cr.lineTo(0, 0);
                cr.lineTo(0, EAR);
                cr.arc(EAR, EAR, EAR, Math.PI, 1.5 * Math.PI);
            } else {
                cr.moveTo(0, 0);
                cr.lineTo(EAR, 0);
                cr.lineTo(EAR, EAR);
                cr.arcNegative(0, EAR, EAR, 0, -0.5 * Math.PI);
            }
            cr.fill();
            cr.$dispose();
        });
        return ear;
    }

    _buildCompact() {
        this._compact = new St.BoxLayout({
            style_class: 'gnotch-compact',
            x_expand: true,
            y_expand: true,
        });
        this._compactLeft = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        this._compactRight = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        // Center slot: the clock, or the owner's own content (e.g. track title)
        this._compactCenter = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        this._clock = new Anim.MorphText({
            style_class: 'gnotch-clock',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Changed digits morph in the clock; showing/hiding animates this wrapper
        this._clockBin = new St.Bin({
            child: this._clock.actor,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clockBin.set_pivot_point(0.5, 0.5);
        this._compactCenter.add_child(this._clockBin);
        this._compact.add_child(this._compactLeft);
        this._compact.add_child(this._compactCenter);
        this._compact.add_child(this._compactRight);
        this._compact.set_pivot_point(0.5, 0.5);
        this._pill.add_child(this._compact);

        this._wallClock = new GnomeDesktop.WallClock({time_only: true});
        this._wallClock.connectObject('notify::clock', () => {
            this._clock.text = this._wallClock.clock;
        }, this);
        this._clock.text = this._wallClock.clock;
    }

    _buildPeek() {
        this._peek = new St.Widget({
            style_class: 'gnotch-peek',
            layout_manager: new Clutter.BinLayout(),
            width: PEEK_WIDTH,
            height: PEEK_HEIGHT,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            visible: false,
        });
        this._peek.set_pivot_point(0.5, 0.5);
        const row = new St.BoxLayout({
            style_class: 'gnotch-peek-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._peekIcon = new St.Icon({
            style_class: 'gnotch-peek-icon',
            icon_size: 26,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._peekIcon.set_pivot_point(0.5, 0.5);
        this._peekCover = new Cover({size: 30, radius: 8});
        this._peekCover.actor.set_pivot_point(0.5, 0.5);
        this._peekCover.actor.hide();
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._peekTitle = new St.Label({style_class: 'gnotch-peek-title'});
        this._peekBody = new St.Label({style_class: 'gnotch-peek-body'});
        text.add_child(this._peekTitle);
        text.add_child(this._peekBody);
        // Level meter for volume / brightness / keyboard backlight
        this._peekMeter = new St.BoxLayout({style_class: 'gnotch-peek-meter', y_align: Clutter.ActorAlign.CENTER});
        // Same bar as GNOME's OSD
        this._peekLevel = new BarLevel({style_class: 'level', y_align: Clutter.ActorAlign.CENTER});
        this._peekValue = new St.Label({style_class: 'gnotch-peek-value', y_align: Clutter.ActorAlign.CENTER});
        this._peekMeter.add_child(this._peekLevel);
        this._peekMeter.add_child(this._peekValue);

        row.add_child(this._peekIcon);
        row.add_child(this._peekCover.actor);
        row.add_child(text);
        row.add_child(this._peekMeter);
        // A widget's own live content (e.g. a call's voice waves)
        this._peekExtra = new St.Bin({y_align: Clutter.ActorAlign.CENTER, visible: false});
        row.add_child(this._peekExtra);
        // Round buttons for peeks that ask something (accept / decline...)
        this._peekActions = new St.BoxLayout({style_class: 'gnotch-peek-actions', y_align: Clutter.ActorAlign.CENTER, visible: false});
        row.add_child(this._peekActions);

        // Countdown line showing how long the peek stays
        this._peekProgress = new St.Widget({
            style_class: 'gnotch-peek-progress',
            x_expand: true,
            y_align: Clutter.ActorAlign.END,
        });
        this._peekProgress.set_pivot_point(0, 0.5);

        this._peek.add_child(row);
        this._peek.add_child(this._peekProgress);
        this._pill.add_child(this._peek);
    }

    _buildExpanded() {
        this._expanded = new St.BoxLayout({
            style_class: 'gnotch-expanded',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            visible: false,
        });
        this._expanded.set_pivot_point(0.5, 0);

        // Tab bar: a sliding indicator underneath the icon buttons
        this._tabBar = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._tabIndicator = new St.Widget({
            style_class: 'gnotch-tab-indicator',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.FILL,
            width: 0,
        });
        this._tabButtons = new St.BoxLayout({style_class: 'gnotch-tabs'});
        this._tabBar.add_child(this._tabIndicator);
        this._tabBar.add_child(this._tabButtons);
        this._indicator = new Anim.Spring(this._tabIndicator, {l: 0, r: 0}, v => {
            this._tabIndicator.translation_x = v.l;
            this._tabIndicator.width = Math.max(0, v.r - v.l);
        });

        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });
        this._expanded.add_child(this._tabBar);
        this._expanded.add_child(this._stack);
        this._pill.add_child(this._expanded);
        this._tabs = [];
    }

    _populate() {
        // Compact pill pieces
        for (const widget of this._widgets.values()) {
            for (const actor of [widget.compactLeft, widget.compactRight]) {
                if (!actor)
                    continue;
                actor.set_pivot_point(0.5, 0.5);
                actor.hide();
            }
            if (widget.compactLeft)
                this._compactLeft.add_child(widget.compactLeft);
            if (widget.compactRight)
                this._compactRight.add_child(widget.compactRight);
            if (widget.compactCenter) {
                widget.compactCenter.hide();
                this._compactCenter.add_child(widget.compactCenter);
            }
        }

        // Home tab: media card | divider | tile grid
        const home = new St.BoxLayout({style_class: 'gnotch-home', x_expand: true, y_expand: true});
        const media = this._widgets.get('media');
        if (media) {
            media.page.x_expand = true;
            home.add_child(media.page);
            home.add_child(new St.Widget({style_class: 'gnotch-divider', y_expand: true}));
        }
        const grid = new Clutter.GridLayout({
            column_homogeneous: true,
            row_homogeneous: true,
            column_spacing: 12, // as in the Quick Settings grid
            row_spacing: 12,
        });
        const tiles = new St.Widget({style_class: 'gnotch-tiles', layout_manager: grid, y_expand: true});
        TILE_WIDGETS.flatMap(name => this._widgets.get(name)?.tiles ?? [])
            .forEach((tile, i) => grid.attach(tile, i % 2, Math.floor(i / 2), 1, 1));
        home.add_child(tiles);

        this._addTab('go-home-symbolic', home, {
            widgets: [media, this._widgets.get('battery')].filter(Boolean),
            // Cascade the media card's parts, then each tile
            staggerTargets: () => [...(media?.page.get_children() ?? []), ...tiles.get_children()],
        });

        for (const [name, widget] of this._widgets) {
            if (name !== 'media' && widget.page)
                this._addTab(widget.tabIcon, widget.page, {widgets: [widget]});
        }
        this._selectTab(0);
    }

    _addTab(iconName, page, {widgets, staggerTargets}) {
        const index = this._tabs.length;
        const icon = new St.Icon({icon_name: iconName, icon_size: 16});
        const button = new St.Button({
            style_class: 'icon-button gnotch-tab',
            can_focus: true,
            track_hover: true,
            child: icon,
        });
        button.connect('clicked', () => this._selectTab(index));
        page.x_expand = true;
        page.y_expand = true;
        page.visible = false;
        this._tabButtons.add_child(button);
        this._stack.add_child(page);
        this._tabs.push({
            button,
            icon,
            page,
            widgets,
            staggerTargets: staggerTargets ?? (() => page.get_children()),
        });
    }

    _selectTab(index, {force = false} = {}) {
        const old = this._currentTab;
        if (index === old && !force)
            return;
        const tab = this._tabs[index];
        if (!tab)
            return;
        this._currentTab = index;
        const animate = this._state === 'expanded' && this._expanded.mapped;

        this._tabs.forEach((t, i) => {
            if (i === index)
                t.button.add_style_pseudo_class('checked');
            else
                t.button.remove_style_pseudo_class('checked');
        });

        if (!animate) {
            this._tabs.forEach((t, i) => {
                t.page.remove_all_transitions();
                t.page.set({visible: i === index, opacity: 255, translation_x: 0});
            });
        } else {
            // Pages slide in the direction of travel; the old one drifts out the other way
            const dir = index > old ? 1 : -1;
            const oldTab = this._tabs[old];
            if (oldTab && old !== index)
                Anim.fadeOut(oldTab.page, {dx: -dir * 26, duration: 170});
            Anim.fadeIn(tab.page, {dx: dir * 24, duration: 250, delay: 30});
            Anim.stagger(tab.staggerTargets(), {dy: 6, delay: 60, step: 25, duration: 250});
        }

        this._moveIndicator(animate);
        if (this._state === 'expanded') {
            this._expanded.height = this._expandedHeight();
            this._reshape(SHAPE.expand);
            tab.widgets.forEach(w => w.onShown?.());
        }
    }

    /** Fits the selected tab: tab bar + page content + padding, within bounds. */
    _expandedHeight() {
        const page = this._tabs[this._currentTab]?.page;
        const [left, top, right, bottom] = EXPANDED_PADDING;
        const contentWidth = this._settings.get_uint('expanded-width') - left - right;
        const [, tabBar] = this._tabBar.get_preferred_height(contentWidth);
        const [, content] = page?.get_preferred_height(contentWidth) ?? [0, 0];
        const spacing = this._expanded.layout_manager.spacing;
        const height = Math.ceil(top + tabBar + spacing + content + bottom);
        return Math.min(EXPANDED_MAX_HEIGHT, Math.max(EXPANDED_MIN_HEIGHT, height));
    }

    _moveIndicator(animate) {
        const button = this._tabs[this._currentTab]?.button;
        if (!button)
            return;
        if (!button.has_allocation()) {
            // Hidden tab bars never get allocated; _enterExpanded places it later
            if (this._state === 'expanded')
                this._queueLater(() => this._moveIndicator(false));
            return;
        }
        const l = button.x;
        const r = button.x + button.width;
        if (!animate || this._indicator.values.r === 0) {
            this._indicator.set({l, r});
            return;
        }
        // Leading edge is quick, trailing edge lags: the pill stretches then catches up
        const movingRight = l > this._indicator.values.l;
        const lead = Anim.Springs.SNAPPY;
        const trail = Anim.Springs.LAZY;
        this._indicator.animateTo({l, r}, movingRight ? {l: trail, r: lead} : {l: lead, r: trail});
    }

    /** Re-fits the expanded height when a widget's page changed size while shown. */
    refit(widget) {
        if (this._state !== 'expanded' || !this._tabs[this._currentTab]?.widgets.includes(widget))
            return;
        this._expanded.height = this._expandedHeight();
        this._reshape(SHAPE.expand);
    }

    selectWidget(widget) {
        const index = this._tabs.findIndex(t => t.widgets.includes(widget) && t.widgets.length === 1);
        if (index >= 0)
            this._selectTab(index);
    }

    // ---- API used by widgets ----

    /** Whether a widget shows this notification its own way (the notifications widget then doesn't peek). */
    claimsNotification(source, notification) {
        return [...this._widgets.values()].some(w => w.claimsNotification?.(source, notification));
    }

    get settings() {
        return this._settings;
    }

    get extensionPath() {
        return this._path;
    }

    get expanded() {
        return this._state === 'expanded';
    }

    /** Re-evaluates which widget owns the compact pill. */
    updateCompact() {
        let owner = null;
        for (const widget of this._widgets.values()) {
            if (!owner && widget.wantsCompact?.())
                owner = widget;
        }
        for (const widget of this._widgets.values()) {
            const mine = widget === owner;
            const was = this._compactShown.get(widget) ?? false;
            this._compactShown.set(widget, mine);
            if (mine !== was) {
                if (widget.compactCenter) {
                    if (mine)
                        Anim.fadeIn(widget.compactCenter, {dy: 4, delay: 150, duration: 250});
                    else
                        Anim.fadeOut(widget.compactCenter, {dy: -4, duration: 120});
                }
                [widget.compactLeft, widget.compactRight].forEach((actor, i) => {
                    if (!actor)
                        return;
                    if (mine) {
                        Anim.fadeIn(actor, {
                            scale: 0.85,
                            dx: i === 0 ? 6 : -6,
                            delay: 110 + i * 40,
                            duration: 250,
                            mode: EASE_OUT_QUAD,
                        });
                    } else {
                        Anim.fadeOut(actor, {scale: 0.5, duration: 140});
                    }
                });
            }
            widget.onCompactVisible?.(mine);
        }
        const ownerChanged = owner !== this._compactOwner;
        this._compactOwner = owner;

        // The clock gives way when the owner brings its own center content
        const showClock = !owner || (owner.showClockInCompact && !owner.compactCenter);
        this._clockBin.ease({
            opacity: showClock ? 255 : 0,
            scale_x: showClock ? 1 : 0.85,
            scale_y: showClock ? 1 : 0.85,
            duration: showClock ? 360 : 160,
            delay: showClock ? 120 : 0,
            mode: showClock ? EASE_OUT_QUAD : Clutter.AnimationMode.EASE_IN_QUAD,
        });
        if (ownerChanged && this._state === 'compact')
            this._reshape(SHAPE.compact);
    }

    /**
     * Briefly widens the pill to show an event.
     *
     * @param {object} p
     * @param {Gio.Icon} [p.gicon]
     * @param {string} [p.iconName]
     * @param {string} p.title
     * @param {string} [p.body]
     * @param {number} [p.level] - 0..1, shows a level meter
     * @param {string} [p.key] - a peek with the same key updates in place
     * @param {boolean} [p.urgent] - jump the queue
     * @param {number} [p.duration] - ms
     * @param {object[]} [p.actions] - round buttons: {iconName, style, onActivate}
     * @param {boolean} [p.sticky] - stays until updated or ended (endPeek)
     * @param {boolean} [p.force] - closes the open notch to show it
     * @param {Clutter.Actor} [p.extra] - the widget's own content, before the buttons (it stays the widget's)
     * @param {object} [p.widget] - clicking the peek opens this widget's tab
     * @returns {boolean} whether the notch shows it
     */
    peek(p) {
        if (this._state === 'expanded') {
            if (!p.force)
                return false;
            this.collapse();
        }
        if (this.updatePeek(p))
            return true;
        const queued = p.key ? this._peekQueue.findIndex(q => q.key === p.key) : -1;
        if (queued >= 0) {
            this._peekQueue[queued] = p;
            return true;
        }
        // A sticky peek (a ringing or ongoing call) steps aside for anything
        // new and comes back after it, instead of holding up the queue
        const displacing = this._state === 'peek' && this._currentPeek?.sticky;
        if (p.urgent || displacing) {
            if (displacing)
                this._peekQueue.unshift(this._currentPeek);
            this._peekQueue.unshift(p);
        } else {
            this._peekQueue.push(p);
        }
        if (this._state !== 'peek' || p.urgent || displacing)
            this._showNextPeek();
        return true;
    }

    /** Changes the showing peek with the same key in place; false if it isn't showing. */
    updatePeek(p) {
        if (!p.key || this._state !== 'peek' || this._currentPeek?.key !== p.key)
            return false;
        this._updatePeek(p);
        return true;
    }

    /** The peek on screen, or null. */
    get currentPeek() {
        return this._state === 'peek' ? this._currentPeek : null;
    }

    /** Removes the peek with this key, showing or queued. */
    endPeek(key) {
        this._peekQueue = this._peekQueue.filter(q => q.key !== key);
        if (this._state === 'peek' && this._currentPeek?.key === key) {
            this._cancel('peek');
            this._showNextPeek();
        }
    }

    _updatePeek(p) {
        const old = this._currentPeek;
        this._currentPeek = p;
        if ((p.glow ?? 'sweep') !== (old?.glow ?? 'sweep') || p.glow === 'flash')
            this._playGlow(p);
        if (p.gicon)
            Anim.swapIcon(this._peekIcon, {gicon: p.gicon});
        else if (p.iconName && p.iconName !== old?.iconName)
            Anim.swapIcon(this._peekIcon, {gicon: null, icon_name: p.iconName});
        this._peekTitle.text = p.title ?? '';
        if (p.body !== undefined) {
            this._peekBody.text = p.body;
            this._peekBody.visible = !!p.body;
        }
        this._setPeekLevel(p.level, true);
        if (p.actions !== old?.actions)
            this._setPeekActions(p.actions);
        this._setPeekExtra(p.extra);
        this._startPeekTimer(p);
    }

    _setPeekExtra(extra = null) {
        if (this._peekExtra.child !== extra)
            this._peekExtra.child = extra;
        this._peekExtra.visible = !!extra;
    }

    _setPeekActions(actions = []) {
        this._peekActions.destroy_all_children();
        for (const action of actions) {
            const button = new St.Button({
                style_class: `gnotch-peek-action ${action.style ?? ''}`,
                can_focus: true,
                child: new St.Icon({icon_name: action.iconName, icon_size: 16}),
            });
            button.connect('clicked', () => action.onActivate());
            button.set_pivot_point(0.5, 0.5);
            this._peekActions.add_child(button);
        }
        this._peekActions.visible = actions.length > 0;
        Anim.stagger(this._peekActions.get_children(), {scale: 0.6, delay: 120, step: 50, duration: 250});
    }

    _setPeekLevel(level, animate) {
        this._peekMeter.visible = level !== undefined;
        if (level === undefined)
            return;
        const value = Math.min(1, Math.max(0, level));
        this._peekValue.text = `${Math.round(level * 100)}`;
        // Like the Shell OSD: ease the value when it changes while shown
        if (animate)
            this._peekLevel.ease_property('value', value, {duration: 100, mode: EASE_OUT_QUAD});
        else
            this._peekLevel.value = value;
    }

    _startPeekTimer(p) {
        if (p.sticky) {
            this._cancel('peek');
            this._peekProgress.remove_all_transitions();
            this._peekProgress.opacity = 0;
            return;
        }
        const duration = p.duration ?? this._settings.get_uint('peek-duration-ms');
        this._peekProgress.remove_all_transitions();
        this._peekProgress.set({scale_x: 1, opacity: 0});
        this._peekProgress.ease({opacity: 255, duration: 300, delay: 250});
        this._peekProgress.ease({scale_x: 0, duration, mode: LINEAR});
        this._schedule('peek', duration, () => this._showNextPeek());
    }

    /** Shows Shell OSDs (volume, brightness, keyboard backlight...) in the notch. */
    _onOsd(icon, label, level, maxLevel) {
        const name = icon?.to_string() ?? '';
        const title = /keyboard/.test(name) ? 'Keyboard backlight'
            : /brightness/.test(name) ? 'Brightness'
                : /microphone|audio-input/.test(name) ? 'Microphone'
                    : /audio|speaker|headphone/.test(name) ? 'Volume'
                        : label ?? '';
        const hasLevel = typeof level === 'number' && level >= 0;
        return this.peek({
            key: `osd:${title}`,
            urgent: true,
            gicon: icon,
            title,
            body: label && label !== title ? label : '',
            level: hasLevel ? level / (maxLevel > 0 ? maxLevel : 1) : undefined,
            duration: OSD_DURATION_MS,
            glow: 'flash', // these come in bursts: no sweep each time
        });
    }

    _hookOsd() {
        const osd = Main.osdWindowManager;
        this._osdOriginal = {show: osd.show, showAll: osd.showAll};
        // While expanded (or on error) fall back to the regular Shell OSD
        osd.show = (icon, label, levels) => {
            const l = Object.values(levels ?? {}).find(Boolean);
            if (!this._onOsdSafe(icon, label, l?.level, l?.maxLevel))
                this._osdOriginal.show.call(osd, icon, label, levels);
        };
        osd.showAll = (icon, label, level, maxLevel) => {
            if (!this._onOsdSafe(icon, label, level, maxLevel))
                this._osdOriginal.showAll.call(osd, icon, label, level, maxLevel);
        };
    }

    _onOsdSafe(...args) {
        try {
            return this._onOsd(...args);
        } catch (e) {
            logError(e);
            return false;
        }
    }

    _unhookOsd() {
        const osd = Main.osdWindowManager;
        // Instance properties shadow the prototype methods; removing them restores Shell's
        delete osd.show;
        delete osd.showAll;
    }

    // ---- file drops ----

    // While files are dragged over the notch it opens the widget that takes
    // drops (acceptsDrops); releasing over the notch hands it the files,
    // which it reads from the drag's DND selection.
    _hookDnd() {
        Main.xdndHandler.connectObject(
            'drag-begin', () => {
                this._dragging = true;
            },
            'drag-end', () => this._onDragEnd(),
            this);
        global.backend.get_dnd().connectObject('dnd-position-change',
            (_dnd, x, y) => this._onDragMotion(x, y), this);
    }

    get _dropWidget() {
        return [...this._widgets.values()].find(w => w.acceptsDrops) ?? null;
    }

    _containsPoint(x, y) {
        const [px, py] = this._pill.get_transformed_position();
        const [w, h] = this._pill.get_transformed_size();
        return x >= px && x < px + w && y >= py && y < py + h;
    }

    _onDragMotion(x, y) {
        const widget = this._dropWidget;
        if (!this._dragging || !widget)
            return;
        if (!this._dropActive && this._containsPoint(x, y)) {
            this._dropActive = true;
            this._cancel('collapse');
            if (this._state !== 'expanded')
                this.expand();
            this.selectWidget(widget);
            widget.dragEnter();
        }
    }

    _onDragEnd() {
        this._dragging = false;
        if (!this._dropActive)
            return;
        this._dropActive = false;
        // Released over the notch: the widget takes the dragged files
        const [x, y] = global.get_pointer();
        const dropped = this._containsPoint(x, y);
        this._dropWidget?.dragEnd(dropped);
        if (!dropped) {
            this._schedule('collapse', this._settings.get_uint('collapse-delay-ms'),
                () => this.collapse());
        }
    }

    /** Takes keyboard focus (needed to type into entries). */
    grabKeyboard(focusActor) {
        if (!this._grab)
            this._grab = Main.pushModal(this._pill, {actionMode: Shell.ActionMode.NORMAL});
        focusActor?.grab_key_focus();
    }

    // ---- state machine ----

    _showNextPeek() {
        const p = this._peekQueue.shift();
        if (!p) {
            this._currentPeek = null;
            this._setState('compact');
            return;
        }

        this._currentPeek = p;
        this._playGlow(p);
        const fill = () => {
            // Album art gets a rounded cover; everything else an icon
            this._peekVisual = p.cover ? this._peekCover.actor : this._peekIcon;
            this._peekCover.actor.visible = !!p.cover;
            this._peekIcon.visible = !p.cover;
            if (p.cover)
                this._peekCover.set(p.cover);
            else if (p.gicon)
                this._peekIcon.gicon = p.gicon;
            else
                this._peekIcon.set({gicon: null, icon_name: p.iconName ?? 'dialog-information-symbolic'});
            this._peekTitle.text = p.title ?? '';
            this._peekBody.text = p.body ?? '';
            this._peekBody.visible = !!p.body;
            this._setPeekLevel(p.level, false);
            this._setPeekActions(p.actions);
            this._setPeekExtra(p.extra);
            this._animatePeekContent();
            if (p.level !== undefined)
                this._setPeekLevel(p.level, true);
        };

        if (this._state === 'peek') {
            // Back-to-back peeks: swap the content and give the shape a little bump
            Anim.fadeOut(this._peekVisual ?? this._peekIcon, {scale: 0.6, duration: 100, hide: false});
            Anim.fadeOut(this._peekBody, {dy: -6, duration: 100, hide: false});
            Anim.fadeOut(this._peekTitle, {dy: -6, duration: 100, hide: false, onComplete: fill});
            this._shape.kick({w: 260, h: 60});
        } else {
            // Show the layer first: eases on unmapped actors finish instantly
            this._setState('peek');
            fill();
        }

        this._startPeekTimer(p);
    }

    _animatePeekContent() {
        Anim.fadeIn(this._peekVisual, {scale: 0.8, delay: 70, duration: 250, mode: EASE_OUT_QUAD});
        Anim.fadeIn(this._peekTitle, {dx: 8, delay: 100, duration: 250});
        if (this._peekBody.visible)
            Anim.fadeIn(this._peekBody, {dx: 8, delay: 130, duration: 250});
    }

    expand() {
        // A clicked peek opens its widget's tab; so does a widget waiting on an answer (e.g. an incoming file)
        const focus = this._currentPeek?.widget ?? [...this._widgets.values()].find(w => w.wantsFocus?.());
        this._cancel('peek');
        this._peekQueue = [];
        this._currentPeek = null;
        if (focus)
            this.selectWidget(focus);
        this._setState('expanded');
    }

    collapse() {
        this._cancel('collapse');
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        if (this._state === 'expanded') {
            this._setState('compact');
            // e.g. an ongoing call shows itself again
            this._widgets.forEach(w => w.onCollapsed?.());
        }
    }

    // Clicking expands (see the button-press handler); leaving the notch collapses it
    _onHover() {
        if (this._dropActive)
            return; // the pill ignores the pointer while files are dragged onto it
        if (this._pill.hover) {
            this._cancel('collapse');
        } else if (this._state === 'expanded') {
            this._schedule('collapse', this._settings.get_uint('collapse-delay-ms'),
                () => this.collapse());
        }
        // Anticipation: the pill swells slightly under the pointer
        if (this._state !== 'expanded')
            this._reshape(SHAPE.hover);
    }

    _setState(state) {
        const old = this._state;
        if (old === state)
            return;
        this._state = state;

        if (old === 'peek')
            this._glow.release();

        // Outgoing content leaves quickly so the shape change reads clearly
        switch (old) {
        case 'compact':
            Anim.fadeOut(this._compact, {scale: 0.9, duration: 120});
            break;
        case 'peek':
            this._peekProgress.remove_all_transitions();
            Anim.fadeOut(this._peek, {dy: -4, scale: 0.97, duration: 140});
            break;
        case 'expanded':
            Anim.fadeOut(this._expanded, {dy: -8, scale: 0.95, duration: 160});
            break;
        }

        switch (state) {
        case 'compact':
            Anim.fadeIn(this._compact, {scale: 0.95, delay: 100, duration: 250});
            this._reshape(SHAPE.collapse);
            break;
        case 'peek':
            this._peek.remove_all_transitions();
            this._peek.set({visible: true, opacity: 255, translation_y: 0, scale_x: 1, scale_y: 1});
            this._reshape(SHAPE.peek);
            break;
        case 'expanded':
            this._enterExpanded();
            break;
        }
        this._syncGlass();
    }

    _syncGlass() {
        if (!this._shape)
            return; // called while constructing
        const glass = this._state === 'expanded' &&
            this._settings.get_boolean('glass-expanded') && this._glass.available;
        this._shape.animateTo({g: glass ? 1 : 0}, glass ? GLASS_IN : GLASS_OUT);
    }

    _enterExpanded() {
        this._expanded.set_size(this._settings.get_uint('expanded-width'), this._expandedHeight());
        this._reshape(SHAPE.expand);

        Anim.fadeIn(this._expanded, {dy: -8, scale: 0.98, delay: 50, duration: 250});

        // Tab icons pop in one after another, then the page content cascades
        this._tabs.forEach((tab, i) => Anim.fadeIn(tab.button, {
            dy: -4, delay: 90 + i * 25, duration: 250, mode: EASE_OUT_QUAD,
        }));
        const tab = this._tabs[this._currentTab];
        if (tab) {
            this._tabs.forEach(t => {
                t.page.remove_all_transitions();
                t.page.set({visible: t === tab, opacity: 255, translation_x: 0});
            });
            Anim.stagger(tab.staggerTargets(), {dy: 6, delay: 100, step: 25, duration: 250});
            tab.widgets.forEach(w => w.onShown?.());
        }
        this._indicator.set({l: 0, r: 0});
        this._queueLater(() => this._moveIndicator(false));
        this._tabIndicator.set_pivot_point(0.5, 0.5);
        Anim.fadeIn(this._tabIndicator, {delay: 150, duration: 250, mode: EASE_OUT_QUAD});
    }

    // ---- shape ----

    _targetSize() {
        switch (this._state) {
        case 'expanded':
            return [this._settings.get_uint('expanded-width'), this._expanded.height];
        case 'peek':
            return this._bulge([PEEK_WIDTH, PEEK_HEIGHT]);
        default:
            return this._bulge([
                this._compactOwner?.compactWidth ?? (this._compactOwner ? ACTIVE_WIDTH : IDLE_WIDTH),
                COMPACT_HEIGHT,
            ]);
        }
    }

    _bulge([w, h]) {
        return this._pill.hover ? [w + HOVER_BULGE[0], h + HOVER_BULGE[1]] : [w, h];
    }

    _reshape(springs) {
        const [w, h] = this._targetSize();
        this._shape.animateTo({w, h}, springs);
    }

    _applyShape({w, h, g}) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        // Never let a spring overshoot collapse the pill below a sliver
        const width = Math.max(40, Math.round(w));
        const height = Math.max(8, Math.round(h));
        const x = monitor.x + Math.round((monitor.width - width) / 2);

        this.actor.set_position(x - EAR, monitor.y);
        this.actor.set_size(width + 2 * EAR, height);
        this._pill.set_position(EAR, 0);
        this._pill.set_size(width, height);
        this._earLeft.set_position(0, 0);
        this._earRight.set_position(EAR + width, 0);

        const radius = cornerRadius(height);
        this._radius = radius;
        this._pillOrigin = [x, monitor.y];
        this._glow.setShape({x: EAR, width, height, radius});
        this._queuePointer();

        // Black dissolves into frosted glass; the shoulders melt away with it
        const glass = Math.min(1, Math.max(0, g));
        this._glass.radius = radius;
        this._glass.progress = glass;
        const alpha = (1 - glass * (1 - GLASS_TINT)).toFixed(3);
        const tintStyle = `border-radius: 0 0 ${radius}px ${radius}px; background-color: rgba(0, 0, 0, ${alpha});`;
        if (tintStyle !== this._tintStyle) {
            this._tintStyle = tintStyle;
            this._tint.style = tintStyle;
        }
        const earOpacity = Math.round(255 * (1 - glass));
        this._earLeft.opacity = earOpacity;
        this._earRight.opacity = earOpacity;
    }

    // ---- glow ----

    _syncGlow() {
        this._glow.enabled = this._settings.get_boolean('glow-enabled');
        this._glow.hoverEnabled = this._glow.enabled && this._settings.get_boolean('glow-hover');
        if (!this._glow.enabled)
            this._glow.release();
        this._queuePointer();
    }

    /** Plays a peek's glow: p.glow is sweep (default), loop, pulse, flash, hold or false. */
    _playGlow(p) {
        const kind = p.glow ?? 'sweep';
        if (kind === false)
            this._glow.release();
        else
            this._glow.play(kind, p.glowColor ? rgb(p.glowColor) : this._smartGlowColor(p));
    }

    /** A colour for what the peek is about; none for music, whose titles are song names. */
    _smartGlowColor(p) {
        if (p.cover || p.key?.startsWith('osd:'))
            return null;
        return glowColorFor({
            app: p.app,
            icon: p.iconName ?? p.gicon?.to_string?.(),
            title: p.title,
            body: p.body,
            critical: p.critical,
        });
    }

    /** Hands the pointer to the glow, at most once per frame. */
    _queuePointer() {
        if (this._pointerLaterId || !this._pillOrigin)
            return;
        this._pointerLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._pointerLaterId = 0;
            const [px, py] = global.get_pointer();
            this._glow.setPointer(px - this._pillOrigin[0], py - this._pillOrigin[1]);
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncClock() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (dateMenu)
            dateMenu.container.visible = !this._settings.get_boolean('hide-clock');
    }

    // ---- timers ----

    _schedule(name, ms, callback) {
        this._cancel(name);
        this._timeouts.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _cancel(name) {
        const id = this._timeouts.get(name);
        if (id) {
            GLib.source_remove(id);
            this._timeouts.delete(name);
        }
    }

    _queueLater(callback) {
        const laters = global.compositor.get_laters();
        if (this._laterId)
            laters.remove(this._laterId);
        this._laterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        for (const id of this._timeouts.values())
            GLib.source_remove(id);
        this._timeouts.clear();
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        this._unhookOsd();
        global.backend.get_cursor_tracker().disconnectObject(this);
        if (this._pointerLaterId)
            global.compositor.get_laters().remove(this._pointerLaterId);
        this._pointerLaterId = 0;
        this._glow.destroy();
        Main.xdndHandler.disconnectObject(this);
        global.backend.get_dnd().disconnectObject(this);
        this._shape.destroy();
        this._glass.destroy();
        this._peekCover.destroy();
        this._indicator.destroy();

        Main.layoutManager.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._wallClock.disconnectObject(this);
        this._wallClock = null;

        const dateMenu = Main.panel.statusArea.dateMenu;
        if (dateMenu)
            dateMenu.container.visible = true;

        for (const widget of this._widgets.values())
            widget.destroy();
        this._widgets.clear();

        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
        this.actor = null;
    }
}
