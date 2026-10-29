// A glowing line around the notch's edge: it lights up near the pointer and
// sweeps, loops, pulses or flashes for events.
//
// Ported from glow-card by Franz Schlögel (https://github.com/mulkatz/glow-card,
// MIT). glow-card masks a radial gradient (border) or a conic gradient
// (glow-line) to a thin ring with CSS; St has no masks or such gradients, so
// here the edge is sampled into short pieces and each is stroked with its own
// brightness, with wider faint passes for the blurred halo.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

const MARGIN = 20; // room for the halo around the notch
const STEP = 3; // px of edge per sample
const LEVELS = 24; // brightness steps; equal neighbours are stroked as one run

const HOVER_SIGMA = 60; // px of edge lit around the point nearest the pointer
const HOVER_RANGE = 120; // the glow starts this far from the notch
const HOVER_FADE_MS = 90; // time constant of the hover fade

const SWEEP_MS = 900;
const LOOP_MS = 2400;
const BREATH_MS = 2000;
const FLASH_MS = 450;
const RELEASE_MS = 300;
const HOLD = 0.28; // the soft glow while a peek shows
const BREATH = 0.08;

// GNOME's accent colours (libadwaita)
const ACCENTS = {
    BLUE: '#3584e4', TEAL: '#2190a4', GREEN: '#3a944a', YELLOW: '#c88800', ORANGE: '#ed5b00',
    RED: '#e62d42', PINK: '#d56199', PURPLE: '#9141ac', SLATE: '#6f8396',
};

/** '#rrggbb' as [r, g, b] (0..1). */
export function rgb(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/** The user's accent colour as [r, g, b] (0..1). */
export function accentColor() {
    const value = St.Settings.get().accent_color;
    const name = Object.keys(St.SystemAccentColor).find(k => St.SystemAccentColor[k] === value);
    return rgb(ACCENTS[name] ?? ACCENTS.BLUE);
}

const easeInOut = t => t < 0.5 ? 4 * t ** 3 : 1 - (2 - 2 * t) ** 3 / 2;

export class Glow {
    constructor() {
        this.actor = new St.DrawingArea({reactive: false, visible: false});
        this.actor.connect('repaint', area => this._paint(area));
        this.enabled = true;
        this.hoverEnabled = true;
        this._accent = accentColor();
        this._shape = null; // {x, width, height, radius}, x in the notch container
        this._samples = []; // [{x, y, s}] along the edge, s in 0..1
        this._length = 0;
        this._event = null; // {kind, color, start, releasedAt}
        this._hover = {target: 0, value: 0, s: 0.5};
        this._lastFrame = 0;

        St.Settings.get().connectObject('notify::accent-color', () => {
            this._accent = accentColor();
        }, this);
        this._timeline = new Clutter.Timeline({actor: this.actor, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._frame());
    }

    get _animate() {
        return St.Settings.get().enable_animations;
    }

    // ---- inputs ----

    /** The notch's current shape; x is the pill's left edge in the notch container. */
    setShape({x, width, height, radius}) {
        const s = this._shape;
        if (s && s.x === x && s.width === width && s.height === height && s.radius === radius)
            return;
        this._shape = {x, width, height, radius};
        this.actor.set_position(x - MARGIN, 0);
        this.actor.set_size(width + 2 * MARGIN, height + MARGIN);
        this._sample();
        if (this.actor.visible)
            this.actor.queue_repaint();
    }

    /** The pointer relative to the pill's top-left corner. */
    setPointer(x, y) {
        const shape = this._shape;
        if (!shape || !this.enabled || !this.hoverEnabled) {
            this._hover.target = 0;
            return;
        }
        const dx = Math.max(-x, 0, x - shape.width);
        const dy = Math.max(-y, 0, y - shape.height);
        const target = Math.max(0, 1 - Math.hypot(dx, dy) / HOVER_RANGE);
        this._hover.target = target;
        if (target > 0) {
            // The edge point nearest the pointer
            let best = Infinity;
            for (const p of this._samples) {
                const d = (p.x - MARGIN - x) ** 2 + (p.y - y) ** 2;
                if (d < best) {
                    best = d;
                    this._hover.s = p.s;
                }
            }
        }
        this._wake();
    }

    /**
     * Starts an event glow, replacing the current one.
     *
     * @param {string} kind - sweep, loop, pulse, flash or hold
     * @param {number[]} [color] - [r, g, b] 0..1; the accent by default
     */
    play(kind, color = null) {
        if (!this.enabled)
            return;
        this._event = {kind, color: color ?? this._accent, start: this._now(), releasedAt: 0};
        this._wake();
    }

    /** Fades the event glow out (e.g. the peek closed). */
    release() {
        if (this._event && !this._event.releasedAt)
            this._event.releasedAt = this._now();
    }

    // ---- animation ----

    _now() {
        return Date.now();
    }

    _wake() {
        if (!this._timeline.is_playing()) {
            this._lastFrame = this._now();
            this.actor.show();
            this._timeline.start();
        }
        this.actor.queue_repaint();
    }

    _frame() {
        const now = this._now();
        const dt = Math.max(0, now - this._lastFrame);
        this._lastFrame = now;

        const hover = this._hover;
        hover.value += (hover.target - hover.value) * (1 - Math.exp(-dt / HOVER_FADE_MS));
        if (Math.abs(hover.value - hover.target) < 0.005)
            hover.value = hover.target;

        const event = this._event;
        if (event) {
            const age = now - event.start;
            const released = event.releasedAt && now - event.releasedAt >= RELEASE_MS;
            if (released || (event.kind === 'flash' && age >= FLASH_MS))
                this._event = null;
        }

        if (!this._event && hover.value <= 0.005) {
            this._timeline.stop();
            this.actor.hide();
            return;
        }
        this.actor.queue_repaint();
    }

    /** Brightness of the event glow at edge position s (0..1). */
    _eventAt(s, now) {
        const event = this._event;
        if (!event)
            return 0;
        const age = now - event.start;
        const animate = this._animate;
        const breath = animate ? Math.sin(2 * Math.PI * age / BREATH_MS) * BREATH : 0;
        let value;
        switch (event.kind) {
        case 'sweep':
            if (animate && age < SWEEP_MS) {
                // A comet from the top-left around to the top-right, then the hold glow
                const progress = age / SWEEP_MS;
                const head = -0.05 + 1.1 * easeInOut(progress);
                const d = head - s;
                const comet = d < 0 ? Math.exp(-((d / 0.035) ** 2)) : Math.exp(-d / 0.12);
                value = Math.max(comet, HOLD * progress);
            } else {
                value = HOLD + breath;
            }
            break;
        case 'loop':
            if (animate) {
                const head = 0.5 - 0.5 * Math.cos(2 * Math.PI * age / LOOP_MS);
                value = Math.max(0.08, Math.exp(-(((head - s) / 0.06) ** 2)));
            } else {
                value = HOLD;
            }
            break;
        case 'pulse':
            value = 0.21 + (animate ? Math.sin(2 * Math.PI * age / BREATH_MS) * 0.09 : 0);
            break;
        case 'flash':
            value = 0.5 * Math.max(0, 1 - age / FLASH_MS) ** 1.5;
            break;
        default: // hold
            value = HOLD + breath;
        }
        if (event.releasedAt)
            value *= Math.max(0, 1 - (now - event.releasedAt) / RELEASE_MS);
        return value;
    }

    // ---- geometry ----

    /** Samples the notch's open U: left side, bottom corners and edge, right side. */
    _sample() {
        const {width: w, height: h} = this._shape;
        const r = Math.min(this._shape.radius, h, w / 2);
        const x0 = MARGIN + 0.75;
        const x1 = MARGIN + w - 0.75;
        const yb = h - 0.75;
        const rr = Math.max(0, r - 0.75);
        const points = [];
        const line = (ax, ay, bx, by) => {
            const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / STEP));
            for (let i = 0; i < n; i++)
                points.push([ax + (bx - ax) * i / n, ay + (by - ay) * i / n]);
        };
        const arc = (cx, cy, from, to) => {
            const n = Math.max(1, Math.ceil(Math.abs(to - from) * rr / STEP));
            for (let i = 0; i < n; i++) {
                const a = from + (to - from) * i / n;
                points.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
            }
        };
        line(x0, 0, x0, yb - rr);
        arc(x0 + rr, yb - rr, Math.PI, Math.PI / 2);
        line(x0 + rr, yb, x1 - rr, yb);
        arc(x1 - rr, yb - rr, Math.PI / 2, 0);
        line(x1, yb - rr, x1, 0);
        points.push([x1, 0]);

        let length = 0;
        const lengths = points.map((p, i) => {
            if (i > 0)
                length += Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]);
            return length;
        });
        this._length = length;
        this._samples = points.map((p, i) => ({x: p[0], y: p[1], s: length ? lengths[i] / length : 0}));
    }

    _pillPath(cr) {
        const {width: w, height: h} = this._shape;
        const r = Math.min(this._shape.radius, h, w / 2);
        const x0 = MARGIN;
        const x1 = MARGIN + w;
        cr.moveTo(x0, -1);
        cr.lineTo(x0, h - r);
        cr.arcNegative(x0 + r, h - r, r, Math.PI, Math.PI / 2);
        cr.lineTo(x1 - r, h);
        cr.arcNegative(x1 - r, h - r, r, Math.PI / 2, 0);
        cr.lineTo(x1, -1);
        cr.closePath();
    }

    // ---- drawing ----

    _paint(area) {
        const cr = area.get_context();
        if (!this._shape || this._samples.length < 2) {
            cr.$dispose();
            return;
        }
        const now = this._now();
        const hover = this._hover.value;
        const sigma = HOVER_SIGMA / Math.max(1, this._length);
        const eventColor = this._event?.color ?? this._accent;

        // Brightness and colour mix (0 = accent hover, 1 = event colour) per sample
        const levels = this._samples.map(({s}) => {
            const h = hover > 0 ? hover * Math.exp(-0.5 * ((s - this._hover.s) / sigma) ** 2) : 0;
            const e = this._eventAt(s, now);
            const alpha = Math.min(1, Math.max(h, e));
            const mix = h + e > 0 ? e / (h + e) : 1;
            return {alpha: Math.round(alpha * LEVELS) / LEVELS, mix: Math.round(mix * 3) / 3};
        });
        const colorOf = mix => this._accent.map((c, i) => c + (eventColor[i] - c) * mix);

        const pass = (lineWidth, strength) => {
            // Drawn into a group with SOURCE: where neighbouring strokes
            // overlap, the later one replaces the earlier instead of adding
            // to it, so round caps close every gap without bright seams.
            // Runs of equal brightness are stroked as one path.
            cr.pushGroup();
            cr.setOperator(Cairo.Operator.SOURCE);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            cr.setLineWidth(lineWidth);
            let start = 0;
            for (let i = 1; i <= this._samples.length; i++) {
                const end = i === this._samples.length;
                if (!end && levels[i].alpha === levels[start].alpha && levels[i].mix === levels[start].mix)
                    continue;
                const alpha = levels[start].alpha * strength;
                if (alpha > 0.003) {
                    const [r, g, b] = colorOf(levels[start].mix);
                    cr.setSourceRGBA(r, g, b, alpha);
                    cr.moveTo(this._samples[start].x, this._samples[start].y);
                    for (let j = start + 1; j <= Math.min(i, this._samples.length - 1); j++)
                        cr.lineTo(this._samples[j].x, this._samples[j].y);
                    cr.stroke();
                }
                start = i;
            }
            cr.popGroupToSource();
            cr.paint();
        };

        // The halo only spreads outside the notch, so its content stays clear
        cr.save();
        cr.setFillRule(Cairo.FillRule.EVEN_ODD);
        const [width, height] = area.get_surface_size();
        cr.rectangle(0, 0, width, height);
        this._pillPath(cr);
        cr.clip();
        pass(28, 0.07);
        pass(14, 0.16);
        pass(6, 0.4);
        cr.restore();
        pass(2, 1);
        cr.$dispose();
    }

    destroy() {
        St.Settings.get().disconnectObject(this);
        this._timeline.stop();
        this._timeline = null;
        this.actor.destroy();
    }
}
