import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Anim from '../anim.js';

const MAX_ITEMS = 30;

export class NotificationsWidget {
    constructor(notch) {
        this._notch = notch;
        this._items = []; // newest first
        this.tabIcon = 'preferences-system-notifications-symbolic';
        this._desktopSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});

        this.page = new St.BoxLayout({
            style_class: 'gnotch-page',
            orientation: Clutter.Orientation.VERTICAL,
        });
        const header = new St.BoxLayout({style_class: 'gnotch-page-header'});
        header.add_child(new St.Label({text: 'Notifications', style_class: 'gnotch-page-title', x_expand: true}));
        const clear = new St.Button({style_class: 'gnotch-pill-button', label: 'Clear', can_focus: true});
        Anim.addButtonMotion(clear, {hover: 1.05, press: 0.9});
        clear.connect('clicked', () => this._clearAll());
        header.add_child(clear);
        this.page.add_child(header);

        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'gnotch-list'});
        this._empty = new St.Label({text: 'No notifications', style_class: 'gnotch-empty', x_align: Clutter.ActorAlign.CENTER});
        this.page.add_child(this._empty);
        this.page.add_child(new St.ScrollView({
            child: this._list,
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
        }));

        for (const source of Main.messageTray.getSources())
            this._watchSource(source);
        Main.messageTray.connectObject('source-added', (_t, source) => this._watchSource(source), this);
        this._sync();
    }

    _watchSource(source) {
        // Notifications that arrived before the notch started, oldest first so newest ends on top
        for (const notification of source.notifications ?? [])
            this._onNotification(source, notification, false);
        source.connectObject('notification-added', (src, notification) =>
            this._onNotification(src, notification, true), this);
    }

    _onNotification(source, notification, isNew) {
        if (this._items.some(i => i.notification === notification))
            return;
        const row = this._makeRow(source, notification);
        const item = {notification, row};
        this._items.unshift(item);
        this._list.insert_child_at_index(row, 0);
        Anim.rowIn(row, {dx: 0});
        notification.connectObject('destroy', () => this._remove(item), this);

        while (this._items.length > MAX_ITEMS) {
            const old = this._items.pop();
            old.notification.disconnectObject(this);
            Anim.rowOut(old.row);
        }
        this._sync();

        if (isNew && this._desktopSettings.get_boolean('show-banners')) {
            this._notch.peek({
                gicon: notification.gicon ?? source.icon,
                title: notification.title || source.title,
                body: notification.body?.split('\n')[0] ?? '',
            });
        }
    }

    _makeRow(source, notification) {
        const row = new St.Button({style_class: 'gnotch-row', can_focus: true, x_expand: true});
        Anim.addButtonMotion(row, {hover: 1.01, press: 0.97});
        const box = new St.BoxLayout({x_expand: true});
        box.add_child(new St.Icon({
            gicon: notification.gicon ?? source.icon,
            icon_size: 24,
            style_class: 'gnotch-row-icon',
        }));
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const titleBox = new St.BoxLayout();
        const title = new St.Label({text: notification.title || source.title || '', style_class: 'gnotch-row-title', x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleBox.add_child(title);
        titleBox.add_child(new St.Label({
            text: notification.datetime?.format('%H:%M') ?? '',
            style_class: 'gnotch-row-meta',
        }));
        const body = new St.Label({text: (notification.body ?? '').replace(/\n/g, ' '), style_class: 'gnotch-row-body'});
        body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(titleBox);
        text.add_child(body);
        box.add_child(text);
        row.child = box;
        row.connect('clicked', () => {
            this._notch.collapse();
            notification.activate();
        });
        return row;
    }

    _remove(item, delay = 0) {
        const index = this._items.indexOf(item);
        if (index < 0)
            return;
        this._items.splice(index, 1);
        item.notification.disconnectObject(this);
        // Swipe away to the right, then the list closes the gap
        Anim.rowOut(item.row, {delay, dx: 72, onDone: () => this._sync()});
    }

    _clearAll() {
        // Rows leave one after another, top to bottom
        const items = [...this._items];
        items.forEach((item, i) => this._remove(item, i * 40));
        for (const {notification} of items)
            notification.destroy();
    }

    onShown() {
        Anim.stagger(this._list.get_children(), {dy: 8, delay: 140, step: 35, duration: 380});
    }

    _sync() {
        Anim.setShown(this._empty, this._items.length === 0 && this._list.get_n_children() === 0);
    }

    destroy() {
        Main.messageTray.disconnectObject(this);
        for (const source of Main.messageTray.getSources())
            source.disconnectObject(this);
        for (const {notification} of this._items)
            notification.disconnectObject(this);
        this._items = [];
        this._desktopSettings = null;
    }
}
