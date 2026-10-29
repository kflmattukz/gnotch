import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Calendar, DBusEventSource} from 'resource:///org/gnome/shell/ui/calendar.js';

import * as Anim from '../anim.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function sameDay(a, b) {
    return startOfDay(a).getTime() === startOfDay(b).getTime();
}

export class CalendarWidget {
    constructor(notch) {
        this._notch = notch;
        this.tabIcon = 'x-office-calendar-symbolic';
        this._selected = startOfDay(new Date());

        this.page = new St.BoxLayout({style_class: 'gnotch-page gnotch-calendar'});

        // The date menu's own calendar: month header, week days, today, event dots
        this._source = new DBusEventSource();
        this._calendar = new Calendar();
        this._calendar.setEventSource(this._source);
        this._calendar.connectObject('selected-date-changed', (_c, datetime) => {
            this._selected = startOfDay(new Date(datetime.to_unix() * 1000));
            this._showEvents(true);
        }, this);
        this._source.connectObject('changed', () => this._showEvents(false), this);
        this.page.add_child(this._calendar);

        // Selected day's events, styled like the date menu's events section
        // (the theme scopes these as .events-button .events-box .events-list ...)
        const events = new St.Bin({x_expand: true, style_class: 'events-button gnotch-events'});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'events-box'});
        this._dayLabel = new St.Label({style_class: 'events-title'});
        this._events = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'events-list'});
        box.add_child(this._dayLabel);
        box.add_child(new St.ScrollView({
            child: this._events,
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
        }));
        events.child = box;
        this.page.add_child(events);

        this._showEvents(false);
    }

    onShown() {
        // Jump back to today if the day changed while hidden
        const today = startOfDay(new Date());
        if (!sameDay(today, this._today ?? today))
            this._calendar.setDate(today);
        this._showEvents(true);
    }

    _showEvents(animate) {
        const day = this._selected;
        this._today = startOfDay(new Date());
        this._dayLabel.text = sameDay(day, this._today)
            ? 'Today'
            : day.toLocaleDateString(undefined, {weekday: 'long', day: 'numeric', month: 'long'});

        this._events.destroy_all_children();
        const dayEnd = new Date(day.getTime() + DAY_MS);
        const events = this._source.getEvents(day, dayEnd);
        if (!events.length) {
            this._events.add_child(new St.Label({
                text: this._source.hasCalendars ? 'No Events' : 'No Calendars',
                style_class: 'event-placeholder',
            }));
        }

        for (const event of events) {
            const allDay = event.date <= day && event.end >= dayEnd;
            const box = new St.BoxLayout({style_class: 'event-box', orientation: Clutter.Orientation.VERTICAL});
            const summary = new St.Label({text: event.summary ?? '', style_class: 'event-summary'});
            summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(summary);
            box.add_child(new St.Label({
                text: allDay
                    ? 'All Day'
                    : event.date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'}),
                style_class: 'event-time',
            }));
            this._events.add_child(box);
        }
        if (animate)
            Anim.stagger(this._events.get_children(), {dy: 6, delay: 60, step: 25, duration: 250});
    }

    destroy() {
        this._calendar.disconnectObject(this);
        this._source.disconnectObject(this);
        this._source.destroy();
        this._source = null;
    }
}
