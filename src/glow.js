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
const INTENSITY = 0.5; // overall strength: the edge should hint, not shine

const WHITE = [1, 1, 1]; // the pointer glow and events without a colour of their own

// What a peek is about, strongest hints first: the app or icon says more
// than the words. Colours are GNOME's palette, light enough to glow.
const KINDS = [
    {color: '#f66151', app: /dialog-(error|warning)|battery-(caution|low|empty)/,
        text: /\b(error|fail(ed|ure)?|warning|can'?t|couldn'?t|unable|denied|critical|low battery)\b/},
    {color: '#57e389', app: /\bcalls?\b|phone|call-(start|incoming)/,
        text: /\b(incoming|missed) (video )?call\b|\bcalling\b/},
    {color: '#62a0ea', app: /mail|chat|message|telegram|signal-desktop|org\.signal|whatsapp|discord|slack|fractal|element|geary|thunderbird|evolution|polari|chatty/,
        text: /\b(new )?(message|mail|email|reply|mentioned)\b/},
    {color: '#f6d32d', app: /calendar|clock|alarm|reminder|timer|appointment/,
        text: /\b(reminder|meeting|event|alarm|timer|appointment|starts? (in|at)|due)\b/},
    {color: '#c061cb', app: /software|update|package|flatpak|dnf|discover/,
        text: /\b(updates?|upgrade)( available| ready)?\b/},
    {color: '#57e389', app: /emblem-ok|object-select|download-done/,
        text: /\b(complete[d]?|finished|done|downloaded|installed|saved|sent|received|safe to remove)\b/},
];

/** '#rrggbb' as [r, g, b] (0..1). */
export function rgb(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/**
 * A glow colour for what a peek is about, or null (white) when unsure.
 *
 * @param {object} hints
 * @param {string} [hints.app] - app or source id
 * @param {string} [hints.icon] - icon name
 * @param {string} [hints.title]
 * @param {string} [hints.body]
 * @param {boolean} [hints.critical] - a critical notification
 * @returns {number[]|null} [r, g, b] 0..1
 */
export function glowColorFor({app = '', icon = '', title = '', body = '', critical = false}) {
    if (critical)
        return rgb(KINDS[0].color);
    const source = `${app} ${icon}`.toLowerCase();
    const text = `${title} ${body}`.toLowerCase();
    const kind = KINDS.find(k => k.app.test(source)) ?? KINDS.find(k => k.text.test(text));
    return kind ? rgb(kind.color) : null;
}

const easeInOut = t => t < 0.5 ? 4 * t ** 3 : 1 - (2 - 2 * t) ** 3 / 2;

export class Glow {
    constructor() {
        this.actor = new St.DrawingArea({reactive: false, visible: false});
        this.actor.connect('repaint', area => this._paint(area));
        this.enabled = true;
        this.hoverEnabled = true;
        this._shape = null; // {x, y, width, height, radius}, x/y in the notch container
        this._samples = []; // [{x, y, s}] along the edge, s in 0..1
        this._length = 0;
        this._event = null; // {kind, color, start, releasedAt}
        this._hover = {target: 0, value: 0, s: 0.5};
        this._lastFrame = 0;

        this._timeline = new Clutter.Timeline({actor: this.actor, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._frame());
    }

    get _animate() {
        return St.Settings.get().enable_animations;
    }

    // ---- inputs ----

    /** The lit shape: a rounded rect in the notch container. */
    setShape({x, y, width, height, radius}) {
        const s = this._shape;
        if (s && s.x === x && s.y === y && s.width === width && s.height === height && s.radius === radius)
            return;
        this._shape = {x, y, width, height, radius};
        this.actor.set_position(x - MARGIN, y - MARGIN);
        this.actor.set_size(width + 2 * MARGIN, height + 2 * MARGIN);
        this._sample();
        if (this.actor.visible)
            this.actor.queue_repaint();
    }

    /** The pointer relative to the shape's top-left corner. */
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
                const d = (p.x - MARGIN - x) ** 2 + (p.y - MARGIN - y) ** 2;
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
     * @param {number[]} [color] - [r, g, b] 0..1; white by default
     */
    play(kind, color = null) {
        if (!this.enabled)
            return;
        this._event = {kind, color: color ?? WHITE, start: this._now(), releasedAt: 0};
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
                // A comet once around the edge from the top middle, then the hold glow
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

    /** Samples the edge's whole loop, from the top middle going left. */
    _sample() {
        const {width: w, height: h} = this._shape;
        const r = Math.min(this._shape.radius, h / 2, w / 2);
        const x0 = MARGIN + 0.75;
        const x1 = MARGIN + w - 0.75;
        const xm = MARGIN + w / 2;
        const yt = MARGIN + 0.75;
        const yb = MARGIN + h - 0.75;
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
        line(xm, yt, x0 + rr, yt);
        arc(x0 + rr, yt + rr, -Math.PI / 2, -Math.PI);
        line(x0, yt + rr, x0, yb - rr);
        arc(x0 + rr, yb - rr, Math.PI, Math.PI / 2);
        line(x0 + rr, yb, x1 - rr, yb);
        arc(x1 - rr, yb - rr, Math.PI / 2, 0);
        line(x1, yb - rr, x1, yt + rr);
        arc(x1 - rr, yt + rr, 0, -Math.PI / 2);
        line(x1 - rr, yt, xm, yt);
        points.push([xm, yt]);

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
        const r = Math.min(this._shape.radius, h / 2, w / 2);
        const [x0, x1, yt, yb] = [MARGIN, MARGIN + w, MARGIN, MARGIN + h];
        cr.moveTo(x0, yt + r);
        cr.arc(x0 + r, yt + r, r, Math.PI, 1.5 * Math.PI);
        cr.lineTo(x1 - r, yt);
        cr.arc(x1 - r, yt + r, r, 1.5 * Math.PI, 2 * Math.PI);
        cr.lineTo(x1, yb - r);
        cr.arc(x1 - r, yb - r, r, 0, Math.PI / 2);
        cr.lineTo(x0 + r, yb);
        cr.arc(x0 + r, yb - r, r, Math.PI / 2, Math.PI);
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
        const eventColor = this._event?.color ?? WHITE;

        // Brightness and colour mix (0 = white hover, 1 = event colour) per sample
        const levels = this._samples.map(({s}) => {
            const h = hover > 0 ? hover * Math.exp(-0.5 * ((s - this._hover.s) / sigma) ** 2) : 0;
            const e = this._eventAt(s, now);
            const alpha = Math.min(1, Math.max(h, e));
            const mix = h + e > 0 ? e / (h + e) : 1;
            return {alpha: Math.round(alpha * LEVELS) / LEVELS, mix: Math.round(mix * 3) / 3};
        });
        const colorOf = mix => WHITE.map((c, i) => c + (eventColor[i] - c) * mix);

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
                const alpha = levels[start].alpha * strength * INTENSITY;
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
        pass(20, 0.06);
        pass(10, 0.14);
        pass(4, 0.35);
        cr.restore();
        pass(1.5, 1);
        cr.$dispose();
    }

    destroy() {
        this._timeline.stop();
        this._timeline = null;
        this.actor.destroy();
    }
}
