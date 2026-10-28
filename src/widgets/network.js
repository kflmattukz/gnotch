import 'gi://GnomeBluetooth?version=3.0';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeBluetooth from 'gi://GnomeBluetooth';
import NM from 'gi://NM';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Anim from '../anim.js';
import {Tile} from '../tile.js';

Gio._promisify(NM.Client, 'new_async');
Gio._promisify(NM.Client.prototype, 'dbus_set_property');
Gio._promisify(NM.Client.prototype, 'activate_connection_async');
Gio._promisify(NM.Client.prototype, 'add_and_activate_connection_async');
Gio._promisify(NM.DeviceWifi.prototype, 'request_scan_async');

const MAX_NETWORKS = 20;
const {ACTIVATED, FAILED, PREPARE, SECONDARIES} = NM.DeviceState;

function signalIcon(strength) {
    if (strength > 80)
        return 'network-wireless-signal-excellent-symbolic';
    if (strength > 55)
        return 'network-wireless-signal-good-symbolic';
    if (strength > 30)
        return 'network-wireless-signal-ok-symbolic';
    if (strength > 5)
        return 'network-wireless-signal-weak-symbolic';
    return 'network-wireless-signal-none-symbolic';
}

function ssidOf(ap) {
    const ssid = ap?.get_ssid();
    return ssid ? NM.utils_ssid_to_utf8(ssid.get_data()) : '';
}

function isSecured(ap) {
    return ap.wpa_flags !== 0 || ap.rsn_flags !== 0 || (ap.flags & 0x1) !== 0;
}

export class NetworkWidget {
    constructor(notch) {
        this._notch = notch;
        this.tabIcon = 'network-wireless-symbolic';
        this._cancellable = new Gio.Cancellable();
        this._connectedBt = new Set();
        this._btReady = false;
        this._rows = new Map(); // ssid -> {row, icon, status, lock, ap}
        this._announcedSsid = null;
        this._pendingSsid = null;
        this._listTimeout = 0;

        // Home tiles: Wi-Fi opens the network list, Bluetooth toggles power
        this._wifiTile = new Tile({
            iconName: 'network-wireless-symbolic',
            title: 'Wi-Fi',
            onClick: () => this._notch.selectWidget(this),
        });
        this._btTile = new Tile({
            iconName: 'bluetooth-active-symbolic',
            title: 'Bluetooth',
            onClick: () => this._toggleBluetooth(),
        });
        this.tiles = [this._wifiTile.actor, this._btTile.actor];

        this._buildPage();

        this._initWifi().catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e);
        });
        this._initBluetooth();
    }

    // ---- Wi-Fi page ----

    _buildPage() {
        this.page = new St.BoxLayout({
            style_class: 'gnotch-page',
            orientation: Clutter.Orientation.VERTICAL,
        });
        const header = new St.BoxLayout({style_class: 'gnotch-page-header'});
        header.add_child(new St.Label({text: 'Wi-Fi', style_class: 'gnotch-page-title', x_expand: true}));
        this._switch = new St.Button({style_class: 'gnotch-pill-button gnotch-switch', can_focus: true});
        Anim.addButtonMotion(this._switch, {hover: 1.05, press: 0.9});
        this._switch.connect('clicked', () => this._toggleWifi().catch(logError));
        header.add_child(this._switch);
        this.page.add_child(header);

        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'gnotch-list'});
        this._empty = new St.Label({style_class: 'gnotch-empty', x_align: Clutter.ActorAlign.CENTER});
        this.page.add_child(this._empty);
        this.page.add_child(new St.ScrollView({
            child: this._list,
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
        }));
    }

    onShown() {
        this._device?.request_scan_async(null).catch(() => {}); // NM rate-limits scans; ignore
        Anim.stagger(this._list.get_children(), {dy: 8, delay: 140, step: 30, duration: 380});
    }

    _queueList() {
        if (this._listTimeout)
            return;
        // Scans add access points in bursts
        this._listTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._listTimeout = 0;
            this._syncList();
            return GLib.SOURCE_REMOVE;
        });
    }

    _networks() {
        const best = new Map();
        for (const ap of this._device?.get_access_points() ?? []) {
            const ssid = ssidOf(ap);
            if (ssid && !(best.get(ssid)?.strength >= ap.strength))
                best.set(ssid, ap);
        }
        const active = ssidOf(this._device?.active_access_point);
        return [...best.values()]
            .sort((a, b) => (ssidOf(b) === active) - (ssidOf(a) === active) || b.strength - a.strength)
            .slice(0, MAX_NETWORKS);
    }

    _syncList() {
        const enabled = !!this._client?.wireless_enabled;
        const networks = enabled ? this._networks() : [];
        const ssids = networks.map(ssidOf);

        for (const [ssid, entry] of this._rows) {
            if (!ssids.includes(ssid)) {
                this._rows.delete(ssid);
                Anim.rowOut(entry.row);
            }
        }
        networks.forEach((ap, i) => {
            const ssid = ssidOf(ap);
            let entry = this._rows.get(ssid);
            const added = !entry;
            if (added) {
                entry = this._makeRow(ssid);
                this._rows.set(ssid, entry);
                this._list.add_child(entry.row);
            }
            entry.ap = ap;
            this._list.set_child_at_index(entry.row, i);
            this._syncRow(entry);
            if (added)
                Anim.rowIn(entry.row);
        });

        this._empty.text = enabled ? 'Searching for networks…' : 'Wi-Fi is off';
        Anim.setShown(this._empty, networks.length === 0);
    }

    _makeRow(ssid) {
        const row = new St.Button({style_class: 'gnotch-row gnotch-network-row', can_focus: true, x_expand: true});
        const box = new St.BoxLayout({x_expand: true});
        const icon = new St.Icon({icon_size: 16, y_align: Clutter.ActorAlign.CENTER});
        const label = new St.Label({
            text: ssid,
            style_class: 'gnotch-row-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const status = new St.Label({style_class: 'gnotch-row-meta', y_align: Clutter.ActorAlign.CENTER});
        const lock = new St.Icon({
            icon_name: 'channel-secure-symbolic',
            icon_size: 12,
            style_class: 'gnotch-row-meta',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(icon);
        box.add_child(label);
        box.add_child(status);
        box.add_child(lock);
        row.child = box;
        Anim.addButtonMotion(row, {hover: 1.01, press: 0.97});

        const entry = {row, icon, status, lock, ap: null};
        row.connect('clicked', () => this._connect(entry.ap).catch(e => {
            this._pendingSsid = null;
            this._syncAllRows();
            Anim.shake(row);
            this._notch.peek({
                iconName: 'network-wireless-offline-symbolic',
                title: `Couldn't connect to ${ssid}`,
                body: e.message,
            });
        }));
        return entry;
    }

    _syncRow(entry) {
        const {ap} = entry;
        const ssid = ssidOf(ap);
        const activeSsid = ssidOf(this._device?.active_access_point);
        const state = this._device?.state;
        let status = '';
        if (ssid === activeSsid && state === ACTIVATED)
            status = 'Connected';
        else if ((ssid === activeSsid || ssid === this._pendingSsid) && state >= PREPARE && state <= SECONDARIES)
            status = 'Connecting…';
        Anim.swapIcon(entry.icon, {icon_name: signalIcon(ap.strength)});
        Anim.swapText(entry.status, status, {dy: 4});
        entry.lock.visible = isSecured(ap);
        if (status === 'Connected')
            entry.row.add_style_pseudo_class('checked');
        else
            entry.row.remove_style_pseudo_class('checked');
    }

    _syncAllRows() {
        for (const entry of this._rows.values())
            this._syncRow(entry);
    }

    async _connect(ap) {
        if (!ap || !this._device)
            return;
        const ssid = ssidOf(ap);
        if (ssid === ssidOf(this._device.active_access_point) && this._device.state === ACTIVATED)
            return;
        this._pendingSsid = ssid;
        this._syncAllRows();

        // Same approach as Shell's network menu: reuse a saved profile, else create one.
        // Secured networks get their password prompt from Shell's network agent.
        const saved = this._device.filter_connections(this._client.get_connections())
            .find(c => ap.connection_valid(c));
        if (saved) {
            await this._client.activate_connection_async(saved, this._device, ap.get_path(), null);
        } else {
            const connection = new NM.SimpleConnection();
            const setting = new NM.SettingConnection();
            setting.add_permission('user', GLib.get_user_name(), null);
            connection.add_setting(setting);
            // shortcut: WPA-Enterprise needs extra settings; NM fails and we show the error
            await this._client.add_and_activate_connection_async(connection, this._device, ap.get_path(), null);
        }
    }

    // ---- Wi-Fi state ----

    async _initWifi() {
        this._client = await NM.Client.new_async(this._cancellable);
        this._client.connectObject(
            'notify::wireless-enabled', () => this._syncWifi(),
            'notify::primary-connection', () => this._syncWifi(),
            'device-added', () => this._syncWifi(),
            'device-removed', () => this._syncWifi(),
            this);
        this._syncWifi();
        // Don't announce the network we're already on at startup
        if (this._device?.state === ACTIVATED)
            this._announcedSsid = ssidOf(this._device.active_access_point);
    }

    _syncWifi() {
        const device = this._client.get_devices().find(d => d instanceof NM.DeviceWifi);
        if (device !== this._device) {
            this._device?.disconnectObject(this);
            this._device = device ?? null;
            this._device?.connectObject(
                'notify::active-access-point', () => this._syncWifi(),
                'state-changed', (_d, state) => this._onDeviceState(state),
                'access-point-added', () => this._queueList(),
                'access-point-removed', () => this._queueList(),
                this);
        }

        const ap = this._device?.active_access_point ?? null;
        if (ap !== this._ap) {
            this._ap?.disconnectObject(this);
            this._ap = ap;
            this._ap?.connectObject('notify::strength', () => this._syncWifi(), this);
        }

        const enabled = this._client.wireless_enabled;
        this._wifiTile.actor.visible = !!this._device;
        this._wifiTile.checked = enabled;
        this._switch.label = enabled ? 'On' : 'Off';
        if (enabled)
            this._switch.add_style_pseudo_class('checked');
        else
            this._switch.remove_style_pseudo_class('checked');

        if (!enabled) {
            this._wifiTile.setIcon('network-wireless-disabled-symbolic');
            this._wifiTile.setSubtitle('Off');
        } else if (ap && this._device.state === ACTIVATED) {
            this._wifiTile.setIcon(signalIcon(ap.strength));
            this._wifiTile.setSubtitle(ssidOf(ap) || 'Connected');
        } else {
            this._wifiTile.setIcon('network-wireless-offline-symbolic');
            this._wifiTile.setSubtitle(ap ? 'Connecting…' : 'Not connected');
        }
        this._queueList();
    }

    _onDeviceState(state) {
        const ap = this._device.active_access_point;
        const ssid = ssidOf(ap);
        if (state === ACTIVATED && ssid && ssid !== this._announcedSsid) {
            // Covers both switching networks and a connection we started succeeding
            this._announcedSsid = ssid;
            this._pendingSsid = null;
            this._notch.peek({iconName: signalIcon(ap.strength), title: ssid, body: 'Connected to Wi-Fi'});
        } else if (state === FAILED && this._pendingSsid) {
            this._notch.peek({
                iconName: 'network-wireless-offline-symbolic',
                title: `Couldn't connect to ${this._pendingSsid}`,
            });
            this._pendingSsid = null;
        } else if (state < PREPARE) {
            this._announcedSsid = null;
        }
        this._syncWifi();
        this._syncAllRows();
    }

    async _toggleWifi() {
        if (!this._client)
            return;
        await this._client.dbus_set_property(NM.DBUS_PATH, NM.DBUS_INTERFACE,
            'WirelessEnabled', new GLib.Variant('b', !this._client.wireless_enabled),
            2000, null);
    }

    // ---- Bluetooth ----

    _initBluetooth() {
        this._btClient = new GnomeBluetooth.Client();
        this._btClient.connectObject(
            'notify::default-adapter', () => this._syncBluetooth(),
            'notify::default-adapter-powered', () => this._syncBluetooth(),
            'device-added', (_c, device) => this._watchDevice(device),
            'device-removed', () => this._syncBluetooth(),
            this);

        const store = this._btClient.get_devices();
        for (let i = 0; i < store.get_n_items(); i++)
            this._watchDevice(store.get_item(i));
        this._btReady = true;
        this._syncBluetooth();
    }

    _watchDevice(device) {
        device.connectObject('notify::connected', () => this._syncBluetooth(), this);
        this._syncBluetooth();
    }

    _syncBluetooth() {
        const client = this._btClient;
        const hasAdapter = !!client.default_adapter;
        const powered = client.default_adapter_powered;

        const store = client.get_devices();
        const connected = [];
        for (let i = 0; i < store.get_n_items(); i++) {
            const device = store.get_item(i);
            if (device.connected)
                connected.push(device);
        }

        // Peek when a device (e.g. headphones) connects
        const paths = new Set(connected.map(d => d.get_object_path()));
        if (this._btReady) {
            for (const device of connected) {
                if (!this._connectedBt.has(device.get_object_path())) {
                    this._notch.peek({
                        iconName: device.icon ? `${device.icon}-symbolic` : 'bluetooth-active-symbolic',
                        title: device.alias || device.name || 'Bluetooth device',
                        body: 'Connected',
                    });
                }
            }
        }
        this._connectedBt = paths;

        this._btTile.actor.visible = hasAdapter;
        this._btTile.checked = powered;
        this._btTile.setIcon(powered ? 'bluetooth-active-symbolic' : 'bluetooth-disabled-symbolic');
        if (!powered)
            this._btTile.setSubtitle('Off');
        else if (connected.length)
            this._btTile.setSubtitle(connected.map(d => d.alias || d.name).join(', '));
        else
            this._btTile.setSubtitle('On');
    }

    _toggleBluetooth() {
        this._btClient.default_adapter_powered = !this._btClient.default_adapter_powered;
    }

    destroy() {
        this._cancellable.cancel();
        if (this._listTimeout)
            GLib.source_remove(this._listTimeout);
        this._listTimeout = 0;
        this._ap?.disconnectObject(this);
        this._device?.disconnectObject(this);
        this._client?.disconnectObject(this);
        this._client = null;

        const store = this._btClient.get_devices();
        for (let i = 0; i < store.get_n_items(); i++)
            store.get_item(i).disconnectObject(this);
        this._btClient.disconnectObject(this);
        this._btClient = null;
    }
}
