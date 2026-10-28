// Square status tile for the Home grid.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Anim from './anim.js';

export class Tile {
    constructor({iconName = '', title = '', onClick = null}) {
        this.box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this.icon = new St.Icon({
            style_class: 'gnotch-tile-icon',
            icon_name: iconName,
            icon_size: 18,
            x_align: Clutter.ActorAlign.START,
        });
        this.title = new St.Label({style_class: 'gnotch-tile-title', text: title});
        this.subtitle = new St.Label({style_class: 'gnotch-tile-subtitle'});
        this.subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.box.add_child(this.icon);
        this.box.add_child(new St.Widget({y_expand: true})); // pushes text to the bottom
        this.box.add_child(this.title);
        this.box.add_child(this.subtitle);

        this.actor = new St.Button({
            style_class: 'gnotch-tile',
            can_focus: true,
            reactive: !!onClick,
            x_expand: true,
            y_expand: true,
            child: this.box,
        });
        if (onClick) {
            Anim.addButtonMotion(this.actor, {hover: 1.03, press: 0.94});
            this.actor.connect('clicked', onClick);
        }
    }

    set checked(checked) {
        if (checked === this._checked)
            return;
        const first = this._checked === undefined;
        this._checked = checked;
        if (checked)
            this.actor.add_style_pseudo_class('checked');
        else
            this.actor.remove_style_pseudo_class('checked');
        if (!first && this.icon.mapped)
            Anim.pop(this.icon, {from: 0.5});
    }

    setIcon(iconName) {
        Anim.swapIcon(this.icon, {icon_name: iconName});
    }

    setTitle(text) {
        Anim.swapText(this.title, text, {dy: 4});
    }

    setSubtitle(text) {
        Anim.swapText(this.subtitle, text, {dy: 4});
    }
}
