import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {CheckBox} from 'resource:///org/gnome/shell/ui/checkBox.js';
import {QuickToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import * as Anim from '../anim.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
// The finish function of replace_contents_bytes_async is replace_contents_finish
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const {EASE_OUT_QUAD} = Clutter.AnimationMode;
const MAX_VISIBLE_TASKS = 5; // more than this scroll
// #word# in a task becomes a badge; these names get their own colour
const BADGE_RE = /#([\w-]+)#/g;
const BADGE_COLORS = ['important', 'high', 'mid', 'low', 'info'];

/** Splits a task into its title and its #badge# names. */
function parseBadges(text) {
    const badges = [...text.matchAll(BADGE_RE)].map(m => m[1].toLowerCase());
    const title = text.replace(BADGE_RE, ' ').replace(/\s+/g, ' ').trim();
    return {title, badges};
}

export class TodoWidget {
    constructor(notch) {
        this._notch = notch;
        this.tabIcon = 'checkbox-checked-symbolic';
        this._todos = [];
        this._rows = new Map(); // todo -> {row, check}
        this._file = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_data_dir(), 'gnotch', 'todos.json']));

        this.page = new St.BoxLayout({
            style_class: 'gnotch-page',
            orientation: Clutter.Orientation.VERTICAL,
        });
        const header = new St.BoxLayout({style_class: 'gnotch-page-header'});
        header.add_child(new St.Label({text: 'To-do', style_class: 'gnotch-page-title', x_expand: true}));
        const clear = new St.Button({style_class: 'button', label: 'Clear done', can_focus: true});
        clear.connect('clicked', () => this._clearDone());
        header.add_child(clear);
        this.page.add_child(header);

        this._entry = new St.Entry({
            hint_text: 'Add a task — #high# makes a badge',
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
        this._scroll = new St.ScrollView({
            child: this._list,
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
        });
        this.page.add_child(this._scroll);

        // Home tile: open count, opens the list
        this._tile = new QuickToggle({title: 'To-do', icon_name: 'checkbox-checked-symbolic'});
        this._tile.connect('clicked', () => this._notch.selectWidget(this));
        this.tiles = [this._tile];

        this._load().catch(logError);
    }

    onShown() {
        this._notch.grabKeyboard(this._entry);
        Anim.stagger(this._list.get_children(), {dy: 6, delay: 100, step: 25, duration: 250});
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
        // Open tasks first, finished ones at the bottom (stable within each group)
        this._todos = [...this._todos.filter(t => !t.done), ...this._todos.filter(t => t.done)];
        for (const todo of this._todos)
            this._addRow(todo, false);
        this._syncSummary();
        this._fitList();
    }

    async _save() {
        // shortcut: sync mkdir (GIO has no async make_directory_with_parents), so only once
        if (!this._dirReady) {
            const dir = this._file.get_parent();
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);
            this._dirReady = true;
        }
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
        const {row, check} = this._rows.get(todo);
        check.checked = todo.done;
        if (todo.done)
            row.add_style_class_name('done');
        else
            row.remove_style_class_name('done');
        this._moveToGroup(todo);
        this._changed();
    }

    /** Done tasks sink to the bottom; reopened ones rise to the end of the open group. */
    _moveToGroup(todo) {
        const oldIndex = this._todos.indexOf(todo);
        const rest = this._todos.filter(t => t !== todo);
        const newIndex = todo.done ? rest.length : rest.filter(t => !t.done).length;
        rest.splice(newIndex, 0, todo);
        this._todos = rest;
        if (newIndex === oldIndex)
            return;

        // FLIP: reorder now, then slide every affected row from where it was
        const rows = this._todos.map(t => this._rows.get(t).row);
        const moved = this._rows.get(todo).row;
        const step = moved.height + this._list.layout_manager.spacing;
        const [from, to] = [Math.min(oldIndex, newIndex), Math.max(oldIndex, newIndex)];
        this._list.set_child_at_index(moved, newIndex);
        rows.forEach((row, i) => {
            if (i < from || i > to)
                return;
            row.translation_y = row === moved ? (oldIndex - newIndex) * step : (newIndex > oldIndex ? step : -step);
            row.ease({translation_y: 0, duration: 250, mode: EASE_OUT_QUAD});
        });
    }

    _remove(todo, delay = 0) {
        if (this._editing?.todo === todo)
            this._editing.cancel();
        this._todos = this._todos.filter(t => t !== todo);
        const entry = this._rows.get(todo);
        this._rows.delete(todo);
        if (entry)
            Anim.rowOut(entry.row, {delay, dx: 56, onDone: () => {
                this._syncEmpty();
                this._fitList();
            }});
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
        this._tile.subtitle = open === 0 ? 'All done' : `${open} open`;
        this._syncEmpty();
    }

    /**
     * The list grows with its tasks up to MAX_VISIBLE_TASKS rows, then scrolls;
     * the notch follows the new height.
     */
    _fitList() {
        if (!this._list)
            return; // destroyed while a row animation was finishing
        const rows = this._list.get_children();
        // Rows still growing in have a fixed height; measure the settled ones
        const settled = rows.filter(r => !r.natural_height_set);
        // shortcut: assumes rows are the same height; a wrapped long task shows slightly fewer than 5
        const rowHeight = Math.max(0, ...settled.map(r => r.get_preferred_height(-1)[1]));
        const spacing = this._list.layout_manager.spacing;
        this._scroll.height = rows.length > MAX_VISIBLE_TASKS && rowHeight > 0
            ? MAX_VISIBLE_TASKS * rowHeight + (MAX_VISIBLE_TASKS - 1) * spacing
            : -1;
        this._notch.refit(this);
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
        // Native check box; clicking its text toggles too
        const check = new CheckBox('');
        check.set({checked: todo.done, x_expand: true});
        check.connect('clicked', () => this._toggle(todo));
        const badges = new St.BoxLayout({style_class: 'gnotch-badges', y_align: Clutter.ActorAlign.CENTER});
        check.child.add_child(badges);

        // Edit and delete only appear while hovering the row
        const edit = this._rowButton('document-edit-symbolic', () => this._edit(todo));
        const remove = this._rowButton('window-close-symbolic', () => {
            this._remove(todo);
            this._changed();
        });
        row.connect('notify::hover', () => [edit, remove].forEach(button => button.ease({
            opacity: row.hover ? 255 : 0,
            translation_x: row.hover ? 0 : 6,
            duration: 200,
            mode: EASE_OUT_QUAD,
        })));

        row.add_child(check);
        row.add_child(edit);
        row.add_child(remove);
        this._list.add_child(row);
        this._rows.set(todo, {row, check, badges});
        this._fillRow(todo);
        if (animate)
            Anim.rowIn(row, {onDone: () => this._fitList()});
    }

    _rowButton(iconName, callback) {
        const button = new St.Button({
            style_class: 'icon-button flat',
            can_focus: true,
            opacity: 0,
            translation_x: 6,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: iconName}),
        });
        button.connect('clicked', callback);
        return button;
    }

    /** Shows the task's title and its badges. */
    _fillRow(todo) {
        const {check, badges} = this._rows.get(todo);
        const {title, badges: names} = parseBadges(todo.text);
        check.setLabel(title);
        badges.destroy_all_children();
        badges.visible = names.length > 0;
        for (const name of names) {
            const style = BADGE_COLORS.includes(name) ? ` gnotch-badge-${name}` : '';
            badges.add_child(new St.Label({
                text: name,
                style_class: `gnotch-badge${style}`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
    }

    /** Swaps the row's check box for an entry holding the raw text (tags included). */
    _edit(todo) {
        this._editing?.cancel();
        const {row, check} = this._rows.get(todo);
        const entry = new St.Entry({text: todo.text, can_focus: true, x_expand: true});
        check.hide();
        row.insert_child_at_index(entry, 0);

        let finished = false;
        const finish = save => {
            if (finished)
                return;
            const text = entry.text.trim();
            if (save && !text) {
                Anim.shake(entry);
                return;
            }
            finished = true;
            this._editing = null;
            entry.destroy();
            check.show();
            if (save && text !== todo.text) {
                todo.text = text;
                this._fillRow(todo);
                this._changed();
            }
            this._fitList();
        };
        this._editing = {todo, cancel: () => finish(false)};

        entry.clutter_text.connect('activate', () => finish(true));
        entry.clutter_text.connect('key-press-event', (_a, event) => {
            // Escape cancels the edit instead of collapsing the notch
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            finish(false);
            return Clutter.EVENT_STOP;
        });
        entry.clutter_text.connect('key-focus-out', () => finish(false));
        this._notch.grabKeyboard(entry);
        entry.clutter_text.set_selection(0, -1);
        this._fitList();
    }

    destroy() {
        this._editing = null;
        this._rows.clear();
        this._list = null;
        this._entry = null;
    }
}
