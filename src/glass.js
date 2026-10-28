// Frosted-glass backdrop for the expanded notch, rendered by Blur my Shell.
//
// Blur my Shell exposes itself as `global.blur_my_shell`. We build the glass
// with its own Pipeline + RoundedPipeline, exactly like its static top bar
// blur: a wallpaper copy clipped to the notch, blurred by the panel pipeline,
// corners cut inside the blur shader. Without Blur my Shell the notch stays black.

import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const BMS_UUID = 'blur-my-shell@aunetx';
const BOTTOM_CORNERS = 2; // Blur my Shell corner selection: 0 all, 1 top, 2 bottom

export class Glass {
    /** @param {Function} onAvailableChanged */
    constructor(onAvailableChanged) {
        this._onAvailableChanged = onAvailableChanged;
        this.actor = new St.Widget({x_expand: true, y_expand: true, visible: false});
        this._geometry = {x: 0, y: 0, width: 1, height: 1, radius: 0};
        this._generation = 0;

        Main.extensionManager.connectObject('extension-state-changed', (_m, ext) => {
            if (ext.uuid === BMS_UUID)
                this._rebuild().catch(logError);
        }, this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._rebuild().catch(logError), this);
        this._rebuild().catch(logError);
    }

    get available() {
        return !!this._bg;
    }

    async _rebuild() {
        const generation = ++this._generation;
        this._teardown();

        const ext = Main.extensionManager.lookup(BMS_UUID);
        const bms = global.blur_my_shell;
        const monitor = Main.layoutManager.primaryMonitor;
        if (ext?.state !== ExtensionState.ACTIVE || !bms?._effects_manager || !monitor) {
            this._onAvailableChanged();
            return;
        }

        try {
            // Same module URLs as Blur my Shell's own imports, so we share its classes
            const module = path => import(ext.dir.resolve_relative_path(path).get_uri());
            const [{Pipeline}, {RoundedPipeline}] = await Promise.all([
                module('pipelines/pipeline.js'),
                module('render/rounded_pipeline.js'),
            ]);
            if (generation !== this._generation)
                return; // rebuilt or destroyed meanwhile

            this._panelSettings = this._openPanelSettings(ext);
            this._pipeline = new Pipeline(bms._effects_manager, bms._pipelines_manager,
                this._panelSettings.get_string('pipeline'));
            this._managers = [];
            this._bg = this._pipeline.create_background_with_effects(
                monitor.index, this._managers, this.actor, 'gnotch-glass', false);
            this._rounded = new RoundedPipeline(bms._effects_manager,
                () => this._geometry.radius, () => BOTTOM_CORNERS);
            this._rounded.bind(this._pipeline, this._bg);
            this._monitor = monitor;

            // The top bar may switch pipelines; follow it
            this._panelSettings.connectObject('changed::pipeline', () => {
                this._pipeline.change_pipeline_to(this._panelSettings.get_string('pipeline'));
                this._rounded.update();
            }, this);
            this._place();
        } catch (e) {
            console.warn(`gnotch: Blur my Shell glass unavailable: ${e.message}`);
            this._teardown();
        }
        this._onAvailableChanged();
    }

    _openPanelSettings(ext) {
        const source = Gio.SettingsSchemaSource.new_from_directory(
            ext.dir.get_child('schemas').get_path(),
            Gio.SettingsSchemaSource.get_default(), false);
        const schema = source.lookup('org.gnome.shell.extensions.blur-my-shell.panel', true);
        return new Gio.Settings({settings_schema: schema});
    }

    _place() {
        if (!this._bg)
            return;
        const {x, y, width, height} = this._geometry;
        // Like Blur my Shell's static panel: whole-monitor wallpaper, clipped to our area
        const clipX = x - this._monitor.x;
        const clipY = y - this._monitor.y;
        this._bg.set_clip(clipX, clipY, width, height);
        this._bg.set_position(-clipX, -clipY);
    }

    /** Notch geometry on the stage, updated every frame of the shape spring. */
    update(x, y, width, height, radius) {
        const radiusChanged = radius !== this._geometry.radius;
        this._geometry = {x, y, width, height, radius};
        if (!this.actor.visible)
            return;
        this._place();
        if (radiusChanged)
            this._rounded?.update();
    }

    /** 0 = no glass, 1 = full glass. */
    set progress(value) {
        const visible = this.available && value > 0.004;
        if (visible !== this.actor.visible) {
            this.actor.visible = visible;
            if (visible) {
                this._place();
                this._rounded?.update();
            }
        }
        this.actor.opacity = Math.round(255 * value);
    }

    _teardown() {
        this._panelSettings?.disconnectObject(this);
        this._panelSettings = null;
        try {
            this._rounded?.destroy();
            this._pipeline?.destroy();
            this._bg?.destroy();
            this._managers?.forEach(m => m.destroy());
        } catch (e) {
            // Blur my Shell may already have torn its effects down while disabling
            console.debug(`gnotch: glass teardown: ${e.message}`);
        }
        this._rounded = this._pipeline = this._bg = this._managers = null;
    }

    destroy() {
        this._generation++;
        Main.extensionManager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._teardown();
    }
}
