// Frosted-glass backdrop for the expanded notch, rendered by Blur my Shell.
//
// Blur my Shell exposes itself as `global.blur_my_shell`. We use its
// DynamicPipeline (the one its top bar uses in dynamic mode): it captures what
// is actually painted behind the notch, windows included, blurs it with the
// top bar's pipeline and cuts the corners in the blur shader. Static
// (wallpaper-only) blur reads as an opaque gradient over windows, so it is
// not used even when the top bar is static. Without Blur my Shell the notch
// stays black.

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
        this._radius = 0;
        this._progress = 0;
        this._generation = 0;

        Main.extensionManager.connectObject('extension-state-changed', (_m, ext) => {
            if (ext.uuid === BMS_UUID)
                this._rebuild().catch(logError);
        }, this);
        this._rebuild().catch(logError);
    }

    get available() {
        return !!this._pipeline;
    }

    async _rebuild() {
        const generation = ++this._generation;
        this._teardown();

        const ext = Main.extensionManager.lookup(BMS_UUID);
        const bms = global.blur_my_shell;
        if (ext?.state !== ExtensionState.ACTIVE || !bms?._effects_manager) {
            this._onAvailableChanged();
            return;
        }

        try {
            // Same module URL as Blur my Shell's own imports, so we share its classes
            const {DynamicPipeline} = await import(
                ext.dir.resolve_relative_path('render/dynamic_surface.js').get_uri());
            if (generation !== this._generation)
                return; // rebuilt or destroyed meanwhile

            this._panelSettings = this._openPanelSettings(ext);
            this._pipeline = new DynamicPipeline(bms._effects_manager, bms._pipelines_manager,
                this._panelSettings.get_string('pipeline'),
                {corner_radius: this._radius, get_corners: () => BOTTOM_CORNERS});
            // Follows the size of our actor, which fills the pill
            this._pipeline.attach_to_container(this.actor, 'gnotch-glass');
            this._pipeline.set_opacity_factor(this._progress, true);

            // The top bar may switch pipelines; follow it
            this._panelSettings.connectObject('changed::pipeline', () =>
                this._pipeline.change_pipeline_to(this._panelSettings.get_string('pipeline')), this);
            console.log('gnotch: frosted glass rendered by Blur my Shell');
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

    /** Bottom corner radius, updated every frame of the shape spring. */
    set radius(radius) {
        if (radius === this._radius)
            return;
        this._radius = radius;
        this._pipeline?.set_corner_radius(radius);
    }

    /** 0 = no glass, 1 = full glass. Ramps blur radius and brightness, like Blur my Shell's fades. */
    set progress(value) {
        this._progress = value;
        this.actor.visible = this.available && value > 0.004;
        this._pipeline?.set_opacity_factor(value);
    }

    _teardown() {
        this._panelSettings?.disconnectObject(this);
        this._panelSettings = null;
        try {
            this._pipeline?.destroy();
        } catch (e) {
            // Blur my Shell may already have torn its effects down while disabling
            console.debug(`gnotch: glass teardown: ${e.message}`);
        }
        this._pipeline = null;
        this.actor.destroy_all_children();
    }

    destroy() {
        this._generation++;
        Main.extensionManager.disconnectObject(this);
        this._teardown();
    }
}
