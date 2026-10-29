import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const WIDGETS = [
    ['media', 'Media', 'Music and video playing in any app'],
    ['whatsapp', 'WhatsApp', 'Messages and calls from WhatsApp Web in Chrome'],
    ['prayer', 'Prayer times', 'Daily prayer times with reminders'],
    ['pomodoro', 'Pomodoro', 'Focus timer with breaks'],
    ['share', 'Share', 'Send and receive files with LocalSend, using the LocalSend app\'s device name (keep the app closed)'],
    ['battery', 'Battery', 'Charge level, charging state and low-battery alerts'],
    ['network', 'Wi-Fi and Bluetooth', 'Quick toggles and connected devices'],
    ['calendar', 'Calendar', 'Month view and events from your online accounts'],
    ['todo', 'To-do', 'A local task list'],
    ['notifications', 'Notifications', 'Recent notifications'],
    ['devices', 'Drives', 'Mounted USB drives and disks'],
];

// Same keys as METHODS in src/praytimes.js
const PRAYER_METHODS = [
    ['kemenag', 'Kemenag (Indonesia)'],
    ['jakim', 'JAKIM (Malaysia)'],
    ['mwl', 'Muslim World League'],
    ['isna', 'ISNA (North America)'],
    ['egypt', 'Egyptian Authority'],
    ['makkah', 'Umm al-Qura (Makkah)'],
    ['karachi', 'Karachi'],
    ['diyanet', 'Diyanet (Turkey)'],
];
const ASR_METHODS = [
    ['standard', "Standard (Shafi'i, Maliki, Hanbali)"],
    ['hanafi', 'Hanafi'],
];
// [name, latitude, longitude]
const CITIES = [
    ['Jakarta', -6.2088, 106.8456],
    ['Bandung', -6.9175, 107.6191],
    ['Surabaya', -7.2575, 112.7521],
    ['Yogyakarta', -7.7956, 110.3695],
    ['Semarang', -6.9667, 110.4167],
    ['Medan', 3.5952, 98.6722],
    ['Makassar', -5.1477, 119.4327],
    ['Palembang', -2.9761, 104.7754],
    ['Denpasar', -8.6705, 115.2126],
    ['Banda Aceh', 5.5483, 95.3238],
    ['Kuala Lumpur', 3.1390, 101.6869],
    ['Singapore', 1.3521, 103.8198],
    ['Bandar Seri Begawan', 4.9031, 114.9398],
    ['Makkah', 21.4225, 39.8262],
    ['Madinah', 24.4672, 39.6111],
    ['Riyadh', 24.7136, 46.6753],
    ['Dubai', 25.2048, 55.2708],
    ['Doha', 25.2854, 51.5310],
    ['Cairo', 30.0444, 31.2357],
    ['Istanbul', 41.0082, 28.9784],
    ['Karachi', 24.8607, 67.0011],
    ['Lahore', 31.5204, 74.3587],
    ['Dhaka', 23.8103, 90.4125],
    ['Delhi', 28.6139, 77.2090],
    ['Tehran', 35.6892, 51.3890],
    ['Casablanca', 33.5731, -7.5898],
    ['London', 51.5074, -0.1278],
    ['Paris', 48.8566, 2.3522],
    ['Berlin', 52.5200, 13.4050],
    ['New York', 40.7128, -74.0060],
    ['Toronto', 43.6532, -79.3832],
    ['Sydney', -33.8688, 151.2093],
];

/** A combo row bound to a string setting, choosing among [value, label] pairs. */
function stringCombo(settings, key, title, options) {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(options.map(o => o[1]))});
    const sync = () => {
        row.selected = Math.max(0, options.findIndex(o => o[0] === settings.get_string(key)));
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const value = options[row.selected]?.[0];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step, digits = 0) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

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

        const pomodoro = new Adw.PreferencesGroup({title: 'Pomodoro'});
        page.add(pomodoro);
        pomodoro.add(spinRow(settings, 'pomodoro-focus-min', 'Focus', 'Minutes', 1, 120, 1));
        pomodoro.add(spinRow(settings, 'pomodoro-short-min', 'Short break', 'Minutes', 1, 60, 1));
        pomodoro.add(spinRow(settings, 'pomodoro-long-min', 'Long break', 'Minutes', 1, 60, 1));
        pomodoro.add(spinRow(settings, 'pomodoro-rounds', 'Rounds before a long break', '', 1, 12, 1));
        const autoStart = new Adw.SwitchRow({title: 'Start the next phase automatically'});
        settings.bind('pomodoro-auto-start', autoStart, 'active', Gio.SettingsBindFlags.DEFAULT);
        pomodoro.add(autoStart);

        const prayer = new Adw.PreferencesGroup({
            title: 'Prayer times',
            description: 'Calculated offline from your coordinates',
        });
        page.add(prayer);
        const city = new Adw.ComboRow({
            title: 'City',
            subtitle: 'Fills in the coordinates below',
            model: Gtk.StringList.new(['Custom', ...CITIES.map(c => c[0])]),
        });
        const syncCity = () => {
            const lat = settings.get_double('prayer-latitude');
            const lon = settings.get_double('prayer-longitude');
            const i = CITIES.findIndex(c => Math.abs(c[1] - lat) < 1e-3 && Math.abs(c[2] - lon) < 1e-3);
            city.selected = i + 1; // 0 = Custom
        };
        syncCity();
        city.connect('notify::selected', () => {
            const c = CITIES[city.selected - 1];
            if (!c)
                return;
            settings.set_double('prayer-latitude', c[1]);
            settings.set_double('prayer-longitude', c[2]);
        });
        settings.connect('changed::prayer-latitude', syncCity);
        settings.connect('changed::prayer-longitude', syncCity);
        prayer.add(city);
        prayer.add(spinRow(settings, 'prayer-latitude', 'Latitude', 'North positive', -90, 90, 0.01, 4));
        prayer.add(spinRow(settings, 'prayer-longitude', 'Longitude', 'East positive', -180, 180, 0.01, 4));
        prayer.add(stringCombo(settings, 'prayer-method', 'Calculation method', PRAYER_METHODS));
        prayer.add(stringCombo(settings, 'prayer-asr', 'Asr', ASR_METHODS));
        prayer.add(spinRow(settings, 'prayer-reminder-min', 'Reminder',
            'Minutes before each prayer (0 turns it off)', 0, 60, 1));

        const whatsapp = new Adw.PreferencesGroup({
            title: 'WhatsApp',
            description: 'Load the chrome-extension folder from the Gnotch sources in Chrome (chrome://extensions, Developer mode, Load unpacked) and accept the pairing prompt in the notch. It lets the notch hang up calls. The token below is only needed to pair by hand.',
        });
        page.add(whatsapp);
        const token = new Adw.ActionRow({
            title: 'Pairing token',
            subtitle: settings.get_string('whatsapp-token') || 'Created when Gnotch first runs',
            subtitle_selectable: true,
        });
        settings.connect('changed::whatsapp-token', () => {
            token.subtitle = settings.get_string('whatsapp-token');
        });
        const copy = new Gtk.Button({icon_name: 'edit-copy-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Copy'});
        copy.add_css_class('flat');
        copy.connect('clicked', () => copy.get_clipboard().set(settings.get_string('whatsapp-token')));
        const regenerate = new Gtk.Button({icon_name: 'view-refresh-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'New token (unpairs the extension)'});
        regenerate.add_css_class('flat');
        regenerate.connect('clicked', () => settings.set_string('whatsapp-token', GLib.uuid_string_random()));
        token.add_suffix(copy);
        token.add_suffix(regenerate);
        whatsapp.add(token);
        whatsapp.add(spinRow(settings, 'whatsapp-port', 'Port', 'The extension connects to 127.0.0.1 on this port', 1024, 65535, 1));
    }
}
