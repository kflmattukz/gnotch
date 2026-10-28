import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Anim from '../anim.js';
import {Tile} from '../tile.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
// The finish function of replace_contents_bytes_async is replace_contents_finish
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const {EASE_OUT_QUINT} = Clutter.AnimationMode;

export class TodoWidget {
    constructor(notch) {
        this._notch = notch;
        this.tabIcon = 'checkbox-checked-symbolic';
        this._todos = [];
        this._rows = new Map(); // todo -> {row, check, label}
        this._file = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_data_dir(), 'gnotch', 'todos.json']));

        this.page = new St.BoxLayout({
            style_class: 'gnotch-page',
            orientation: Clutter.Orientation.VERTICAL,
        });
        const header = new St.BoxLayout({style_class: 'gnotch-page-header'});
        header.add_child(new St.Label({text: 'To-do', style_class: 'gnotch-page-title', x_expand: true}));
        const clear = new St.Button({style_class: 'gnotch-pill-button', label: 'Clear done', can_focus: true});
        Anim.addButtonMotion(clear, {hover: 1.05, press: 0.9});
        clear.connect('clicked', () => this._clearDone());
        header.add_child(clear);
        this.page.add_child(header);

        this._entry = new St.Entry({
            style_class: 'gnotch-entry',
            hint_text: 'Add a task and press Enter',
            can_focus: true,
            x_expand: true,
        });
        this._entry.clutter_text.connect('activate', () => this._add());
        this._entry.clutter_text.connect('button-press-event', () => {
            this._notch.grabKeyboard(this._entry);
            return Clutter.EVENT_PROPAGATE;
        });
        this.page.add_child(this._entry);

        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'gnotch-list'});
        this._empty = new St.Label({text: 'Nothing to do', style_class: 'gnotch-empty', x_align: Clutter.ActorAlign.CENTER});
        this.page.add_child(this._empty);
        this.page.add_child(new St.ScrollView({
            child: this._list,
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
        }));

        // Home tile: open count, opens the list
        this._tile = new Tile({
            iconName: 'checkbox-checked-symbolic',
            title: 'To-do',
            onClick: () => this._notch.selectWidget(this),
        });
        this.tiles = [this._tile.actor];

        this._load().catch(logError);
    }

    onShown() {
        this._notch.grabKeyboard(this._entry);
        Anim.stagger(this._list.get_children(), {dx: -12, delay: 140, step: 30, duration: 380});
    }

    async _load() {
        try {
            const [contents] = await this._file.load_contents_async(null);
            const data = JSON.parse(new TextDecoder().decode(contents));
            if (Array.isArray(data))
                this._todos = data.filter(t => typeof t?.text === 'string');
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`gnotch: could not read to-dos: ${e.message}`);
        }
        if (!this._list)
            return; // destroyed meanwhile
        for (const todo of this._todos)
            this._addRow(todo, false);
        this._syncSummary();
    }

    async _save() {
        const dir = this._file.get_parent();
        if (!dir.query_exists(null))
            dir.make_directory_with_parents(null);
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(this._todos, null, 2)));
        await this._file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }

    _add() {
        const text = this._entry.text.trim();
        if (!text) {
            Anim.shake(this._entry);
            return;
        }
        const todo = {text, done: false, created: Date.now()};
        this._todos.push(todo);
        this._entry.text = '';
        this._addRow(todo, true);
        this._changed();
    }

    _toggle(todo) {
        todo.done = !todo.done;
        const {row, check, label} = this._rows.get(todo);
        if (todo.done)
            row.add_style_class_name('done');
        else
            row.remove_style_class_name('done');
        Anim.swapIcon(check.child, {icon_name: todo.done ? 'checkbox-checked-symbolic' : 'checkbox-symbolic'});
        // Finished tasks recede; reopened ones come back with a nudge
        label.ease({opacity: todo.done ? 120 : 255, duration: 320, mode: EASE_OUT_QUINT});
        Anim.nudge(label, {dx: todo.done ? 6 : -6});
        this._changed();
    }

    _remove(todo, delay = 0) {
        this._todos = this._todos.filter(t => t !== todo);
        const entry = this._rows.get(todo);
        this._rows.delete(todo);
        if (entry)
            Anim.rowOut(entry.row, {delay, dx: 56, onDone: () => this._syncEmpty()});
    }

    _clearDone() {
        const done = this._todos.filter(t => t.done);
        if (!done.length)
            return;
        done.forEach((todo, i) => this._remove(todo, i * 45));
        this._changed();
    }

    _changed() {
        this._syncSummary();
        this._save().catch(logError);
    }

    _syncSummary() {
        const open = this._todos.filter(t => !t.done).length;
        this._tile.setSubtitle(open === 0 ? 'All done' : `${open} open`);
        this._syncEmpty();
    }

    _syncEmpty() {
        // Wait for rows still swiping out before showing the empty state
        Anim.setShown(this._empty, this._todos.length === 0 && this._list.get_n_children() === 0);
    }

    _addRow(todo, animate) {
        const row = new St.BoxLayout({
            style_class: todo.done ? 'gnotch-row done' : 'gnotch-row',
            reactive: true,
            track_hover: true,
        });
        const check = new St.Button({
            style_class: 'gnotch-icon-button',
            can_focus: true,
            child: new St.Icon({
                icon_name: todo.done ? 'checkbox-checked-symbolic' : 'checkbox-symbolic',
                icon_size: 16,
            }),
        });
        Anim.addButtonMotion(check, {hover: 1.15, press: 0.8});
        check.connect('clicked', () => this._toggle(todo));

        const label = new St.Label({
            text: todo.text,
            style_class: 'gnotch-todo-text',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: todo.done ? 120 : 255,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        // The delete button only appears while hovering the row
        const remove = new St.Button({
            style_class: 'gnotch-icon-button',
            can_focus: true,
            opacity: 0,
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}),
        });
        Anim.addButtonMotion(remove, {hover: 1.15, press: 0.8});
        remove.connect('clicked', () => {
            this._remove(todo);
            this._changed();
        });
        row.connect('notify::hover', () => remove.ease({
            opacity: row.hover ? 255 : 0,
            translation_x: row.hover ? 0 : 6,
            duration: 200,
            mode: EASE_OUT_QUINT,
        }));
        remove.translation_x = 6;

        row.add_child(check);
        row.add_child(label);
        row.add_child(remove);
        this._list.add_child(row);
        this._rows.set(todo, {row, check, label});
        if (animate)
            Anim.rowIn(row);
    }

    destroy() {
        this._rows.clear();
        this._list = null;
        this._entry = null;
    }
}
