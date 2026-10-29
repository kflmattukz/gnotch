// Animation toolkit shared by the notch and its widgets.
//
// Shapes use real spring physics (interruptible, velocity-preserving);
// content uses short choreographed eases built on Shell's actor.ease().

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

const {
    EASE_IN_QUAD, EASE_OUT_QUAD, EASE_OUT_QUINT, EASE_IN_OUT_SINE,
} = Clutter.AnimationMode;

// stiffness / damping for a unit mass; damping ratio = damping / (2 * sqrt(stiffness))
export const Springs = {
    // GNOME motion is restrained: only BOUNCY leaves a light settle
    BOUNCY: {stiffness: 280, damping: 28},  // ζ≈0.84, light settle
    SMOOTH: {stiffness: 300, damping: 31},  // ζ≈0.9, no visible overshoot
    SETTLE: {stiffness: 420, damping: 38},  // ζ≈0.93, lands softly
    SNAPPY: {stiffness: 620, damping: 48},  // ζ≈0.96, quick
    LAZY: {stiffness: 240, damping: 30},    // ζ≈0.97, trailing motion
};

const SUBSTEP = 1 / 240;
const REST_DISTANCE = 0.25;
const REST_VELOCITY = 2;

function animationsEnabled() {
    return St.Settings.get().enable_animations;
}

/**
 * Animates a set of named numbers with damped springs. Retargeting while in
 * flight keeps the current velocity, so interrupted motion never jumps.
 */
export class Spring {
    constructor(actor, values, onUpdate) {
        this._values = {...values};
        this._targets = {...values};
        this._velocity = Object.fromEntries(Object.keys(values).map(k => [k, 0]));
        this._params = Object.fromEntries(Object.keys(values).map(k => [k, Springs.SMOOTH]));
        this._onUpdate = onUpdate;

        this._timeline = new Clutter.Timeline({actor, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._step());
    }

    get values() {
        return this._values;
    }

    get targets() {
        return this._targets;
    }

    /**
     * @param {object} targets - {key: value}
     * @param {object} params - one spring for all keys, or {key: spring}
     */
    animateTo(targets, params = Springs.SMOOTH) {
        for (const [key, value] of Object.entries(targets)) {
            this._targets[key] = value;
            this._params[key] = params[key] ?? (params.stiffness ? params : this._params[key]);
        }
        if (!animationsEnabled()) {
            this.set(this._targets);
            return;
        }
        this._start();
    }

    /** Adds an impulse to the velocity, e.g. for a "bump". */
    kick(velocities) {
        for (const [key, v] of Object.entries(velocities))
            this._velocity[key] += v;
        if (animationsEnabled())
            this._start();
    }

    set(values) {
        for (const [key, value] of Object.entries(values)) {
            this._values[key] = value;
            this._targets[key] = value;
            this._velocity[key] = 0;
        }
        this._onUpdate(this._values);
    }

    _start() {
        if (this._timeline.is_playing())
            return;
        this._lastTime = GLib.get_monotonic_time();
        this._timeline.start();
    }

    _step() {
        const now = GLib.get_monotonic_time();
        // Clamp so a stalled frame doesn't explode the integration
        const dt = Math.min((now - this._lastTime) / 1e6, 1 / 30) /
            Math.max(St.Settings.get().slow_down_factor, 0.01);
        this._lastTime = now;

        const steps = Math.max(1, Math.ceil(dt / SUBSTEP));
        const h = dt / steps;
        let settled = true;

        for (const key of Object.keys(this._values)) {
            const {stiffness, damping} = this._params[key];
            const target = this._targets[key];
            let x = this._values[key];
            let v = this._velocity[key];
            for (let i = 0; i < steps; i++) {
                v += (-stiffness * (x - target) - damping * v) * h;
                x += v * h;
            }
            if (Math.abs(x - target) < REST_DISTANCE && Math.abs(v) < REST_VELOCITY) {
                x = target;
                v = 0;
            } else {
                settled = false;
            }
            this._values[key] = x;
            this._velocity[key] = v;
        }

        this._onUpdate(this._values);
        if (settled)
            this._timeline.stop();
    }

    destroy() {
        this._timeline.stop();
        this._timeline = null;
    }
}

function resetTransform(actor) {
    actor.set({translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1});
}

/** Fades an actor in from an offset/scale to rest. */
export function fadeIn(actor, {
    delay = 0, duration = 250, dx = 0, dy = 0, scale = 1,
    mode = EASE_OUT_QUAD, onComplete,
} = {}) {
    actor.remove_transition('opacity');
    actor.show();
    actor.set({opacity: 0, translation_x: dx, translation_y: dy, scale_x: scale, scale_y: scale});
    actor.ease({
        opacity: 255, translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1,
        delay, duration, mode, onComplete,
    });
}

/** Fades an actor out (and hides it afterwards, unless hide is false). */
export function fadeOut(actor, {
    delay = 0, duration = 160, dx = 0, dy = 0, scale = 1,
    mode = EASE_IN_QUAD, hide = true, onComplete,
} = {}) {
    if (!actor.visible) {
        onComplete?.();
        return;
    }
    actor.ease({
        opacity: 0, translation_x: dx, translation_y: dy, scale_x: scale, scale_y: scale,
        delay, duration, mode,
        onComplete: () => {
            if (hide) {
                actor.hide();
                resetTransform(actor);
                actor.opacity = 255;
            }
            onComplete?.();
        },
    });
}

/** Cascades fadeIn over several actors. */
export function stagger(actors, {step = 35, delay = 0, ...opts} = {}) {
    actors.filter(a => a.visible).forEach((actor, i) =>
        fadeIn(actor, {...opts, delay: delay + i * step}));
}

const pendingText = new WeakMap();

/** Changes a label's text with a vertical roll. */
export function swapText(label, text, {dy = 6} = {}) {
    const current = pendingText.has(label) ? pendingText.get(label) : label.text;
    if (current === text)
        return;
    if (!label.mapped || !label.text) {
        pendingText.delete(label);
        label.remove_transition('opacity');
        label.remove_transition('translation-y');
        label.set({text, opacity: 255, translation_y: 0});
        return;
    }
    pendingText.set(label, text);
    label.ease({
        opacity: 0,
        translation_y: -dy,
        duration: 110,
        mode: EASE_IN_QUAD,
        onComplete: () => {
            label.text = pendingText.get(label);
            pendingText.delete(label);
            label.translation_y = dy;
            label.ease({opacity: 255, translation_y: 0, duration: 250, mode: EASE_OUT_QUAD});
        },
    });
}

const pendingIcon = new WeakMap();

function sameIcon(icon, props) {
    if (props.gicon)
        return !!icon.gicon?.equal(props.gicon);
    return !icon.gicon && icon.icon_name === props.icon_name;
}

/** Changes an icon with a shrink-and-pop. props: {gicon} or {icon_name}. */
export function swapIcon(icon, props) {
    const current = pendingIcon.get(icon);
    if (current ? (current.gicon ? current.gicon.equal(props.gicon ?? null) : current.icon_name === props.icon_name)
        : sameIcon(icon, props))
        return;
    const apply = p => {
        if (p.gicon)
            icon.gicon = p.gicon;
        else
            icon.set({gicon: null, icon_name: p.icon_name});
    };
    if (!icon.mapped) {
        pendingIcon.delete(icon);
        apply(props);
        return;
    }
    icon.set_pivot_point(0.5, 0.5);
    pendingIcon.set(icon, props);
    icon.ease({
        opacity: 0, scale_x: 0.85, scale_y: 0.85,
        duration: 100,
        mode: EASE_IN_QUAD,
        onComplete: () => {
            apply(pendingIcon.get(icon));
            pendingIcon.delete(icon);
            icon.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 250, mode: EASE_OUT_QUAD});
        },
    });
}

/**
 * Slides a group out, runs apply(), then slides the group back in from the
 * other side. dx > 0 means content moves to the left (like "next").
 */
export function slideSwap(actors, apply, {dx = 18, step = 25} = {}) {
    if (!actors.some(a => a.mapped)) {
        apply();
        return;
    }
    let remaining = actors.length;
    actors.forEach((actor, i) => {
        actor.ease({
            opacity: 0,
            translation_x: -dx,
            delay: i * step,
            duration: 120,
            mode: EASE_IN_QUAD,
            onStopped: () => {
                if (--remaining > 0)
                    return;
                apply();
                actors.forEach((a, j) => {
                    a.translation_x = dx;
                    a.ease({
                        opacity: 255, translation_x: 0,
                        delay: j * step * 1.5,
                        duration: 250,
                        mode: EASE_OUT_QUAD,
                    });
                });
            },
        });
    });
}

/** Shake left-right, e.g. to reject empty input. */
export function shake(actor) {
    const offsets = [7, -6, 4, -2, 0];
    const next = i => {
        if (i >= offsets.length)
            return;
        actor.ease({
            translation_x: offsets[i],
            duration: 55,
            mode: EASE_OUT_QUAD,
            onComplete: () => next(i + 1),
        });
    };
    next(0);
}

const breathing = new WeakMap();

/** Slow opacity pulse (e.g. charging); restarts itself when remapped. */
export function breathe(actor, enabled, {low = 110, duration = 1200} = {}) {
    let state = breathing.get(actor);
    if (!state) {
        state = {enabled: false};
        breathing.set(actor, state);
        actor.connect('notify::mapped', () => apply());
    }
    state.enabled = enabled;

    function apply() {
        actor.remove_transition('opacity');
        if (state.enabled && actor.mapped) {
            actor.opacity = 255;
            actor.ease({
                opacity: low,
                duration,
                mode: EASE_IN_OUT_SINE,
                repeatCount: -1,
                autoReverse: true,
            });
        } else {
            actor.opacity = 255;
        }
    }
    apply();
}

/** Grows a freshly added list row open. */
export function rowIn(row, {delay = 0, dx = -14, onDone} = {}) {
    if (!row.mapped) {
        onDone?.();
        return;
    }
    const [, height] = row.get_preferred_height(-1);
    row.clip_to_allocation = true;
    row.set({height: 0, opacity: 0, translation_x: dx});
    row.ease({
        height,
        delay,
        duration: 250,
        mode: EASE_OUT_QUAD,
        onStopped: () => {
            row.height = -1;
            row.clip_to_allocation = false;
            onDone?.();
        },
    });
    row.ease({opacity: 255, translation_x: 0, delay: delay + 60, duration: 250, mode: EASE_OUT_QUAD});
}

/** Swipes a row away, collapses the gap, then destroys it. */
export function rowOut(row, {delay = 0, dx = 48, onDone} = {}) {
    if (!row.mapped) {
        row.destroy();
        onDone?.();
        return;
    }
    row.reactive = false;
    row.clip_to_allocation = true;
    row.height = row.get_height();
    row.ease({opacity: 0, translation_x: dx, delay, duration: 200, mode: EASE_IN_QUAD});
    row.ease({
        height: 0,
        delay: delay + 150,
        duration: 260,
        mode: EASE_OUT_QUINT,
        onStopped: () => {
            row.destroy();
            onDone?.();
        },
    });
}

/** Shows or hides an actor with a fade (no-op when already in that state). */
export function setShown(actor, shown, opts = {}) {
    if (shown === actor.visible && actor.opacity === 255)
        return;
    if (shown)
        fadeIn(actor, {dy: 4, ...opts});
    else
        fadeOut(actor, {duration: 120, ...opts});
}

const MARQUEE_SPEED = 32; // px per second
const MARQUEE_PAUSE_MS = 1600;

/**
 * A single-line label that scrolls back and forth (pausing at each end)
 * when its text doesn't fit, and stays centered when it does.
 */
export class Marquee {
    constructor(styleClass) {
        this.label = new St.Label({style_class: styleClass});
        this.actor = new St.Widget({
            clip_to_allocation: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this.label);
        this._debounceId = 0;

        // Width changes every frame while the pill morphs; settle first
        this.actor.connect('notify::width', () => this._queue());
        this.label.connect('notify::width', () => this._queue());
        this.actor.connect('notify::mapped', () => this._queue());
        this.actor.connect('destroy', () => this._clearDebounce());
    }

    set text(text) {
        swapText(this.label, text, {dy: 5});
        this._queue();
    }

    _clearDebounce() {
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this._debounceId = 0;
    }

    _queue() {
        this._clearDebounce();
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._debounceId = 0;
            this._restart();
            return GLib.SOURCE_REMOVE;
        });
    }

    _restart() {
        const label = this.label;
        label.remove_transition('translation-x');
        label.translation_x = 0;

        const available = this.actor.width;
        const [, natural] = label.get_preferred_width(-1);
        if (natural <= available) {
            label.x = Math.round((available - natural) / 2);
            return;
        }
        label.x = 0;
        if (!this.actor.mapped || !animationsEnabled())
            return;

        const overflow = natural - available;
        const duration = Math.round(overflow / MARQUEE_SPEED * 1000);
        // Unmapped actors finish eases instantly, which would recurse forever;
        // notify::mapped restarts the loop when the label is shown again
        const loop = () => label.mapped && label.ease({
            translation_x: -overflow,
            delay: MARQUEE_PAUSE_MS,
            duration,
            mode: EASE_IN_OUT_SINE,
            onComplete: () => label.mapped && label.ease({
                translation_x: 0,
                delay: MARQUEE_PAUSE_MS,
                duration,
                mode: EASE_IN_OUT_SINE,
                onComplete: loop,
            }),
        });
        loop();
    }
}
