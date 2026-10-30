import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import * as Anim from '../anim.js';

const QUIET_MS = 3000; // nothing new started for this long: the session is ready
const MAX_MS = 45000; // never spin longer than this
const MAX_ICONS = 4;
const COMPACT_WIDTH = 280;

// Right after login: the pill spins and shows each app as autostart opens
// it, then says it's ready once the Shell is up and nothing new has started
// for a few seconds. Only created while the Shell is starting up.
export class StartupWidget {
    constructor(notch) {
        this._notch = notch;
        this._loading = true;
        this._shellReady = false;
        this._apps = new Set(); // opened during startup
        this._starting = new Set();
        this._quietId = 0;

        this._spinner = new Spinner(16, {animate: true});
        this.compactLeft = new St.Bin({child: this._spinner, y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({
            text: 'Starting up',
            style_class: 'gnotch-compact-title',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.compactCenter = this._label;
        this._icons = new St.BoxLayout({style_class: 'gnotch-startup-icons', y_align: Clutter.ActorAlign.CENTER});
        this.compactRight = this._icons;
        this.compactWidth = COMPACT_WIDTH;

        Shell.AppSystem.get_default().connectObject('app-state-changed', (_s, app) => this._onApp(app), this);
        Main.extensionManager.connectObject('extension-state-changed', () => this._arm(), this);
        Main.layoutManager.connectObject('startup-complete', () => {
            this._shellReady = true;
            this._arm();
        }, this);
        this._capId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MAX_MS, () => {
            this._capId = 0;
            this._finish();
            return GLib.SOURCE_REMOVE;
        });
        this._spinner.play();
        this._notch.glow('loop');
        this._arm();
    }

    wantsCompact() {
        return this._loading;
    }

    _onApp(app) {
        if (app.state === Shell.AppState.STARTING) {
            this._starting.add(app);
        } else {
            this._starting.delete(app);
            if (app.state === Shell.AppState.RUNNING && !this._apps.has(app)) {
                this._apps.add(app);
                // Each app pops in as it opens; the oldest leaves
                const icon = app.create_icon_texture(16);
                icon.set_pivot_point(0.5, 0.5);
                this._icons.add_child(icon);
                Anim.fadeIn(icon, {scale: 0.5, duration: 250});
                while (this._icons.get_n_children() > MAX_ICONS)
                    this._icons.get_first_child().destroy();
            }
        }
        const [opening] = this._starting;
        const text = opening ? `Opening ${opening.get_name()}…` : 'Starting up';
        if (text !== this._label.text)
            Anim.swapText(this._label, text);
        this._arm();
    }

    /** (Re)starts the quiet timer: ready when the Shell is up and nothing is opening. */
    _arm() {
        if (!this._loading)
            return;
        if (this._quietId)
            GLib.source_remove(this._quietId);
        this._quietId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, QUIET_MS, () => {
            this._quietId = 0;
            if (this._shellReady && this._starting.size === 0)
                this._finish();
            else
                this._arm();
            return GLib.SOURCE_REMOVE;
        });
    }

    _finish() {
        if (!this._loading)
            return;
        this._loading = false;
        this._disconnect();
        this._spinner.stop();
        this._notch.glow(null);
        this._notch.updateCompact();

        const manager = Main.extensionManager;
        const extensions = manager.getUuids().filter(uuid => manager.lookup(uuid)?.state === ExtensionState.ACTIVE).length;
        const apps = this._apps.size;
        const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
        this._notch.peek({
            iconName: 'emblem-ok-symbolic',
            title: 'Ready',
            body: `${plural(apps, 'app')} · ${plural(extensions, 'extension')}`,
            glowColor: '#57e389',
            urgent: true,
        });
    }

    _disconnect() {
        Shell.AppSystem.get_default().disconnectObject(this);
        Main.extensionManager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        for (const id of [this._quietId, this._capId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._quietId = this._capId = 0;
    }

    destroy() {
        this._loading = false;
        this._disconnect();
    }
}
