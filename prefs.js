import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const WIDGETS = [
    ['media', 'Media', 'Music and video playing in any app'],
    ['battery', 'Battery', 'Charge level, charging state and low-battery alerts'],
    ['network', 'Wi-Fi and Bluetooth', 'Quick toggles and connected devices'],
    ['calendar', 'Calendar', 'Month view and events from your online accounts'],
    ['todo', 'To-do', 'A local task list'],
    ['notifications', 'Notifications', 'Recent notifications'],
    ['devices', 'Drives', 'Mounted USB drives and disks'],
];

export default class GnotchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const widgets = new Adw.PreferencesGroup({title: 'Widgets'});
        page.add(widgets);
        for (const [id, title, subtitle] of WIDGETS) {
            const row = new Adw.SwitchRow({title, subtitle});
            row.active = settings.get_strv('enabled-widgets').includes(id);
            row.connect('notify::active', () => {
                const enabled = new Set(settings.get_strv('enabled-widgets'));
                if (row.active)
                    enabled.add(id);
                else
                    enabled.delete(id);
                // Keep the original order
                settings.set_strv('enabled-widgets', WIDGETS.map(w => w[0]).filter(w => enabled.has(w)));
            });
            widgets.add(row);
        }

        const behavior = new Adw.PreferencesGroup({title: 'Behavior'});
        page.add(behavior);

        const clock = new Adw.SwitchRow({
            title: 'Hide top bar clock',
            subtitle: 'The idle notch shows the time instead',
        });
        settings.bind('hide-clock', clock, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(clock);

        const glass = new Adw.SwitchRow({
            title: 'Frosted glass when expanded',
            subtitle: "Matches Blur my Shell's top bar when it is active",
        });
        settings.bind('glass-expanded', glass, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(glass);

        const spins = [
            ['expand-delay-ms', 'Expand delay', 'Milliseconds of hover before expanding', 0, 2000, 50],
            ['collapse-delay-ms', 'Collapse delay', 'Milliseconds before collapsing after the pointer leaves', 0, 3000, 50],
            ['peek-duration-ms', 'Peek duration', 'How long track changes and alerts stay visible', 500, 10000, 250],
            ['expanded-width', 'Expanded width', 'Width of the open notch in pixels', 480, 1200, 20],
        ];
        for (const [key, title, subtitle, lower, upper, step] of spins) {
            const row = new Adw.SpinRow({
                title,
                subtitle,
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: step}),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            behavior.add(row);
        }
    }
}
