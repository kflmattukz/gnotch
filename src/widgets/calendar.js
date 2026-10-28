import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {DBusEventSource} from 'resource:///org/gnome/shell/ui/calendar.js';

import * as Anim from '../anim.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();
}

export class CalendarWidget {
    constructor(notch) {
        this._notch = notch;
        this.tabIcon = 'x-office-calendar-symbolic';
        this._weekStart = Shell.util_get_week_start();
        this._selected = startOfDay(new Date());
        this._month = new Date(this._selected.getFullYear(), this._selected.getMonth(), 1);

        this._dayButtons = [];

        this._source = new DBusEventSource();
        this._source.connectObject('changed', () => this._rebuild(), this);

        this.page = new St.BoxLayout({style_class: 'gnotch-page gnotch-calendar'});

        // Month grid (clipped so month changes can slide)
        const left = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, clip_to_allocation: true});
        const header = new St.BoxLayout({style_class: 'gnotch-cal-header'});
        const prev = this._iconButton('go-previous-symbolic', () => this._shiftMonth(-1));
        const next = this._iconButton('go-next-symbolic', () => this._shiftMonth(1));
        this._monthLabel = new St.Label({
            style_class: 'gnotch-page-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(prev);
        header.add_child(this._monthLabel);
        header.add_child(next);
        left.add_child(header);

        this._gridLayout = new Clutter.GridLayout();
        this._grid = new St.Widget({style_class: 'gnotch-cal-grid', layout_manager: this._gridLayout});
        left.add_child(this._grid);
        this.page.add_child(left);

        // Selected day's events
        const right = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'gnotch-cal-events',
        });
        this._dayLabel = new St.Label({style_class: 'gnotch-page-title'});
        this._events = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'gnotch-list'});
        right.add_child(this._dayLabel);
        right.add_child(new St.ScrollView({
            child: this._events,
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
        }));
        this.page.add_child(right);

        this._rebuild();
    }

    onShown() {
        // Jump back to today if the day changed while hidden
        const today = startOfDay(new Date());
        if (!sameDay(today, this._today ?? today)) {
            this._selected = today;
            this._month = new Date(today.getFullYear(), today.getMonth(), 1);
        }
        this._rebuild();
        this._animateIn();
    }

    _iconButton(iconName, callback) {
        const button = new St.Button({
            style_class: 'gnotch-icon-button',
            can_focus: true,
            child: new St.Icon({icon_name: iconName, icon_size: 14}),
        });
        Anim.addButtonMotion(button, {hover: 1.12, press: 0.82});
        button.connect('clicked', callback);
        return button;
    }

    _shiftMonth(delta) {
        this._month = new Date(this._month.getFullYear(), this._month.getMonth() + delta, 1);
        // Month and grid slide out together; the new month comes from the side we're heading to
        Anim.slideSwap([this._monthLabel, this._grid], () => this._rebuild(), {dx: 28 * delta, step: 0});
    }

    _select(day, button) {
        if (sameDay(day, this._selected))
            return;
        this._selected = day;
        for (const b of this._dayButtons)
            b.button.remove_style_pseudo_class('selected');
        button.add_style_pseudo_class('selected');
        Anim.pop(button, {from: 0.55, duration: 480});
        this._showEvents(true);
    }

    _gridRange() {
        const offset = (this._month.getDay() - this._weekStart + 7) % 7;
        const begin = new Date(this._month.getFullYear(), this._month.getMonth(), 1 - offset);
        const end = new Date(begin.getFullYear(), begin.getMonth(), begin.getDate() + 42);
        return [begin, end];
    }

    _rebuild() {
        this._today = startOfDay(new Date());
        const [begin, end] = this._gridRange();
        this._source.requestRange(begin, end);

        this._monthLabel.text = this._month.toLocaleDateString(undefined, {month: 'long', year: 'numeric'});
        this._grid.destroy_all_children();
        this._dayButtons = [];

        // Weekday header, starting at the locale's first day of the week
        for (let i = 0; i < 7; i++) {
            const day = new Date(2024, 0, 7 + ((this._weekStart + i) % 7)); // Jan 7 2024 is a Sunday
            this._gridLayout.attach(new St.Label({
                text: day.toLocaleDateString(undefined, {weekday: 'narrow'}),
                style_class: 'gnotch-cal-weekday',
                x_align: Clutter.ActorAlign.CENTER,
            }), i, 0, 1, 1);
        }

        for (let i = 0; i < 42; i++) {
            const day = new Date(begin.getFullYear(), begin.getMonth(), begin.getDate() + i);
            const button = new St.Button({
                label: `${day.getDate()}`,
                style_class: 'gnotch-cal-day',
                can_focus: true,
            });
            Anim.addButtonMotion(button, {hover: 1.14, press: 0.85});
            if (day.getMonth() !== this._month.getMonth())
                button.add_style_class_name('other-month');
            if (sameDay(day, this._today))
                button.add_style_class_name('today');
            if (sameDay(day, this._selected))
                button.add_style_pseudo_class('selected');
            if (this._source.hasEvents(day))
                button.add_style_class_name('has-events');
            button.connect('clicked', () => this._select(day, button));
            this._gridLayout.attach(button, i % 7, 1 + Math.floor(i / 7), 1, 1);
            this._dayButtons.push({day, button});
        }

        this._showEvents(false);
    }

    _showEvents(animate) {
        const day = this._selected;
        const dayText = sameDay(day, this._today)
            ? 'Today'
            : day.toLocaleDateString(undefined, {weekday: 'long', day: 'numeric', month: 'short'});
        if (animate)
            Anim.swapText(this._dayLabel, dayText);
        else
            this._dayLabel.text = dayText;

        this._events.destroy_all_children();
        const dayEnd = new Date(day.getTime() + DAY_MS);
        const events = this._source.getEvents(day, dayEnd);
        if (!events.length) {
            const empty = new St.Label({
                text: this._source.hasCalendars ? 'No events' : 'No calendars set up',
                style_class: 'gnotch-empty',
            });
            this._events.add_child(empty);
            if (animate)
                Anim.fadeIn(empty, {dy: 6, delay: 80});
            return;
        }

        for (const event of events) {
            const allDay = event.date <= day && event.end >= dayEnd;
            const time = allDay
                ? 'All day'
                : event.date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});
            const row = new St.BoxLayout({style_class: 'gnotch-event'});
            row.add_child(new St.Label({text: time, style_class: 'gnotch-event-time'}));
            const summary = new St.Label({text: event.summary ?? '', style_class: 'gnotch-event-summary', x_expand: true});
            summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(summary);
            this._events.add_child(row);
        }
        if (animate)
            Anim.stagger(this._events.get_children(), {dx: 14, delay: 60, step: 45, duration: 420});
    }

    /** Events cascade in whenever the tab is opened. */
    _animateIn() {
        Anim.stagger(this._events.get_children(), {dx: 14, delay: 180, step: 45, duration: 420});
    }

    destroy() {
        this._source.disconnectObject(this);
        this._source.destroy();
        this._source = null;
    }
}
