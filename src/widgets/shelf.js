import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Anim from '../anim.js';
import {readDraggedFiles} from './share.js';

Gio._promisify(Gio.File.prototype, 'query_info_async');

const COMPACT_WIDTH = 210;
const ICON = 'folder-download-symbolic';

// A place to park files for this session: drop them on the notch, then
// open, copy or send them later. Nothing is moved or copied on disk.
export class ShelfWidget {
    constructor(notch) {
        this._notch = notch;
        this.tabIcon = ICON;
        this.acceptsDrops = true;
        this._rows = new Map(); // path -> row

        this.page = new St.BoxLayout({
            style_class: 'gnotch-page',
            orientation: Clutter.Orientation.VERTICAL,
        });
        const header = new St.BoxLayout({style_class: 'gnotch-page-header'});
        header.add_child(new St.Label({text: 'Shelf', style_class: 'gnotch-page-title', x_expand: true}));
        const clear = new St.Button({style_class: 'button', label: 'Clear', can_focus: true});
        clear.connect('clicked', () => [...this._rows.keys()].forEach(path => this._remove(path)));
        header.add_child(clear);
        this.page.add_child(header);

        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'gnotch-list'});
        this._empty = new St.Label({
            text: 'Drop files on the notch to keep them here',
            style_class: 'gnotch-empty',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.page.add_child(this._empty);
        this.page.add_child(new St.ScrollView({
            child: this._list,
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
        }));

        // Compact pill while files wait: shelf icon left, count right (the clock stays)
        this.compactLeft = new St.Icon({icon_name: ICON, icon_size: 16, style_class: 'gnotch-shelf-icon'});
        this._count = new St.Label({style_class: 'gnotch-badge gnotch-shelf-count', y_align: Clutter.ActorAlign.CENTER});
        this.compactRight = new St.Bin({child: this._count, y_align: Clutter.ActorAlign.CENTER});
        this.compactWidth = COMPACT_WIDTH;
        this.bubble = new St.Icon({icon_name: ICON, icon_size: 16, style_class: 'gnotch-shelf-icon'});
    }

    wantsCompact() {
        return this._rows.size > 0;
    }

    get showClockInCompact() {
        return true;
    }

    onShown() {
        Anim.stagger(this._list.get_children(), {dy: 6, delay: 100, step: 25, duration: 250});
    }

    // ---- drops (called by the notch) ----

    dragEnter() {
        // Read now: the selection is gone once the drag ends
        this._dragged = readDraggedFiles();
    }

    /** @param {boolean} dropped - released over the notch */
    async dragEnd(dropped) {
        const paths = await this._dragged;
        this._dragged = null;
        if (!dropped)
            return;
        if (!paths?.length) {
            Anim.shake(this._empty.visible ? this._empty : this._list);
            return;
        }
        this._notch.selectWidget(this);
        for (const path of paths)
            await this._add(path);
        this._sync();
    }

    // ---- rows ----

    async _add(path) {
        if (this._rows.has(path))
            return;
        const file = Gio.File.new_for_path(path);
        let name = GLib.path_get_basename(path), gicon = null;
        try {
            const info = await file.query_info_async('standard::display-name,standard::symbolic-icon',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
            name = info.get_display_name();
            gicon = info.get_symbolic_icon();
        } catch (e) {
            console.debug(`gnotch: shelf: ${e.message}`);
        }
        if (!this.page || this._rows.has(path))
            return; // destroyed or added meanwhile
        const row = this._makeRow(file, name, gicon);
        this._rows.set(path, row);
        this._list.add_child(row);
        Anim.rowIn(row);
    }

    _remove(path) {
        const row = this._rows.get(path);
        if (!row)
            return;
        this._rows.delete(path);
        Anim.rowOut(row, {onDone: () => this._sync()});
        this._sync();
    }

    _sync() {
        this._count.text = `${this._rows.size}`;
        Anim.setShown(this._empty, this._rows.size === 0 && this._list.get_n_children() === 0);
        this._notch.updateCompact();
        this._notch.refit(this);
    }

    _makeRow(file, name, gicon) {
        const row = new St.BoxLayout({style_class: 'gnotch-row gnotch-card', x_expand: true});
        const open = new St.Button({x_expand: true, can_focus: true, style_class: 'popup-menu-item gnotch-row-main'});
        const box = new St.BoxLayout();
        box.add_child(new St.Icon({
            gicon: gicon ?? new Gio.ThemedIcon({name: 'text-x-generic-symbolic'}),
            icon_size: 20,
        }));
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(new St.Label({text: name, style_class: 'gnotch-row-title'}));
        text.add_child(new St.Label({text: file.get_parent()?.get_path() ?? '', style_class: 'gnotch-row-body'}));
        box.add_child(text);
        open.child = box;
        open.connect('clicked', () => {
            this._notch.collapse();
            const context = global.create_app_launch_context(0, -1);
            Gio.AppInfo.launch_default_for_uri(file.get_uri(), context);
        });
        row.add_child(open);

        const copy = this._button('edit-copy-symbolic', () => {
            // Paste into Files or a chat app to drop the file there
            const bytes = new GLib.Bytes(new TextEncoder().encode(`${file.get_uri()}\r\n`));
            St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'text/uri-list', bytes);
            Anim.swapIcon(copy.child, {icon_name: 'object-select-symbolic'});
        });
        row.add_child(copy);
        const share = this._notch.widget('share');
        if (share)
            row.add_child(this._button('send-to-symbolic', () => share.addFiles([file.get_path()]).catch(logError)));
        row.add_child(this._button('window-close-symbolic', () => this._remove(file.get_path())));
        return row;
    }

    _button(iconName, callback) {
        const button = new St.Button({
            style_class: 'icon-button flat',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        button.connect('clicked', callback);
        return button;
    }

    destroy() {
        this._rows.clear();
        this.page = null;
    }
}
