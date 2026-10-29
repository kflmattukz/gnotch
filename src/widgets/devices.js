import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Anim from '../anim.js';

export class DevicesWidget {
    constructor(notch) {
        this._notch = notch;
        this.tabIcon = 'drive-removable-media-symbolic';
        this._monitor = Gio.VolumeMonitor.get();
        this._rows = new Map(); // mount -> row

        this.page = new St.BoxLayout({
            style_class: 'gnotch-page',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this.page.add_child(new St.Label({text: 'Drives', style_class: 'gnotch-page-title'}));
        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'gnotch-list'});
        this._empty = new St.Label({text: 'No drives mounted', style_class: 'gnotch-empty', x_align: Clutter.ActorAlign.CENTER});
        this.page.add_child(this._empty);
        this.page.add_child(new St.ScrollView({
            child: this._list,
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
        }));

        this._monitor.connectObject(
            'mount-added', (_m, mount) => {
                this._sync();
                if (this._isUserMount(mount))
                    this._notch.peek({gicon: mount.get_symbolic_icon(), title: mount.get_name(), body: 'Mounted'});
            },
            'mount-removed', () => this._sync(),
            'mount-changed', () => this._sync(),
            this);
        this._sync();
    }

    _isUserMount(mount) {
        return !mount.is_shadowed() && (mount.can_eject() || mount.can_unmount());
    }

    _sync() {
        // Diff against existing rows so only real changes animate
        const mounts = this._monitor.get_mounts().filter(m => this._isUserMount(m));
        for (const [mount, row] of this._rows) {
            if (!mounts.includes(mount)) {
                this._rows.delete(mount);
                Anim.rowOut(row, {dx: 56, onDone: () => this._syncEmpty()});
            }
        }
        for (const mount of mounts) {
            if (this._rows.has(mount))
                continue;
            const row = this._makeRow(mount);
            this._rows.set(mount, row);
            this._list.add_child(row);
            Anim.rowIn(row);
        }
        this._syncEmpty();
    }

    _syncEmpty() {
        Anim.setShown(this._empty, this._rows.size === 0 && this._list.get_n_children() === 0);
    }

    onShown() {
        Anim.stagger(this._list.get_children(), {dy: 6, delay: 100, step: 25, duration: 250});
    }

    _makeRow(mount) {
        const row = new St.BoxLayout({style_class: 'gnotch-row', x_expand: true});
        const open = new St.Button({x_expand: true, can_focus: true, style_class: 'popup-menu-item gnotch-row-main'});
        const box = new St.BoxLayout();
        box.add_child(new St.Icon({gicon: mount.get_symbolic_icon(), icon_size: 20, style_class: 'gnotch-row-icon'}));
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(new St.Label({text: mount.get_name(), style_class: 'gnotch-row-title'}));
        const path = mount.get_root().get_path();
        if (path)
            text.add_child(new St.Label({text: path, style_class: 'gnotch-row-body'}));
        box.add_child(text);
        open.child = box;
        open.connect('clicked', () => {
            this._notch.collapse();
            const context = global.create_app_launch_context(0, -1);
            Gio.AppInfo.launch_default_for_uri(mount.get_root().get_uri(), context);
        });

        const eject = new St.Button({
            style_class: 'icon-button flat',
            can_focus: true,
            child: new St.Icon({icon_name: 'media-eject-symbolic', icon_size: 16}),
        });
        eject.connect('clicked', () => {
            // The eject arrow bobs while the drive is being released
            eject.child.ease({
                translation_y: -3,
                duration: 260,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                repeatCount: 5,
                autoReverse: true,
            });
            this._eject(mount);
        });

        row.add_child(open);
        row.add_child(eject);
        return row;
    }

    _eject(mount) {
        const op = new Gio.MountOperation();
        const done = (m, res) => {
            try {
                if (m.can_eject())
                    m.eject_with_operation_finish(res);
                else
                    m.unmount_with_operation_finish(res);
                this._notch.peek({gicon: m.get_symbolic_icon(), title: m.get_name(), body: 'Safe to remove'});
            } catch (e) {
                this._notch.peek({iconName: 'dialog-warning-symbolic', title: `Can't eject ${m.get_name()}`, body: e.message});
            }
        };
        if (mount.can_eject())
            mount.eject_with_operation(Gio.MountUnmountFlags.NONE, op, null, done);
        else
            mount.unmount_with_operation(Gio.MountUnmountFlags.NONE, op, null, done);
    }

    destroy() {
        this._rows.clear();
        this._monitor.disconnectObject(this);
        this._monitor = null;
    }
}
