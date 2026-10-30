// The top bar as floating islands: the bar turns transparent and its left
// and right parts become dark capsules, matching the notch between them.
// When a window touches the bar (e.g. maximized) the bar turns solid again,
// so the islands merge into one black strip above the window.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const STYLE = 'gnotch-islands';
const SOLID = 'gnotch-islands-solid';
const TOUCH = 4; // px below the bar that still counts as touching it

export class Islands {
    constructor(settings) {
        this._settings = settings;
        this._settings.connectObject('changed::top-bar-islands', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const enabled = this._settings.get_boolean('top-bar-islands');
        if (enabled === this._enabled)
            return;
        this._enabled = enabled;
        if (enabled) {
            Main.panel.add_style_class_name(STYLE);
            this._hookWindows();
        } else {
            this._unhookWindows();
            Main.panel.remove_style_class_name(STYLE);
            Main.panel.remove_style_class_name(SOLID);
        }
    }

    _hookWindows() {
        const queue = () => this._queue();
        global.display.connectObject('restacked', queue, 'grab-op-end', queue, this);
        global.window_manager.connectObject(
            'map', queue,
            'destroy', queue,
            'minimize', queue,
            'unminimize', queue,
            'size-changed', queue,
            this);
        global.workspace_manager.connectObject('active-workspace-changed', queue, this);
        Main.layoutManager.connectObject('monitors-changed', queue, this);
        this._queue();
    }

    _unhookWindows() {
        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
    }

    /** Checks the windows at most once per frame. */
    _queue() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._syncSolid();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncSolid() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const edge = monitor.y + Main.panel.height + TOUCH;
        const workspace = global.workspace_manager.get_active_workspace();
        const solid = global.get_window_actors().some(({meta_window: win}) =>
            win.get_window_type() === Meta.WindowType.NORMAL && win.showing_on_its_workspace() &&
            win.located_on_workspace(workspace) && win.get_monitor() === monitor.index &&
            win.get_frame_rect().y <= edge);
        if (solid)
            Main.panel.add_style_class_name(SOLID);
        else
            Main.panel.remove_style_class_name(SOLID);
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._unhookWindows();
        Main.panel.remove_style_class_name(STYLE);
        Main.panel.remove_style_class_name(SOLID);
    }
}
