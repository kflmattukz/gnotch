import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';

import * as Anim from '../anim.js';
import {LocalSend} from '../localsend.js';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const MAX_RECEIVED = 3; // shown on the page
const MAX_HISTORY = 20; // kept on disk
const LIST_HEIGHT = 150;
const ERROR_MS = 5000; // how long a send error stays in its device row
const HISTORY_PATH = [GLib.get_user_data_dir(), 'gnotch', 'received.json'];
const PEEK_KEY = 'localsend';
const MESSAGE_PEEK_MS = 10000;

function describeFiles(files) {
    const [first] = files;
    return files.length === 1 ? first.fileName : `${first.fileName} + ${files.length - 1} more`;
}

function formatSize(bytes) {
    return GLib.format_size(bytes);
}

export class ShareWidget {
    constructor(notch) {
        this._notch = notch;
        this.tabIcon = 'send-to-symbolic';
        this.acceptsDrops = true;
        this._files = []; // {file, path, name, size, gicon, row}
        this._deviceRows = new Map(); // fingerprint -> {row, status, cancel}
        this._transfer = null; // outgoing: {peer, cancellable, progress}
        this._incoming = null; // the LocalSend session being asked about or received
        this._history = [];
        this._historyFile = Gio.File.new_for_path(GLib.build_filenamev(HISTORY_PATH));
        this._decoder = new TextDecoder();

        this._buildPage();

        // Compact pill while sending or receiving: icon left, progress right
        this.compactLeft = new St.Icon({icon_name: 'send-to-symbolic', icon_size: 16, style_class: 'gnotch-share-icon'});
        this._miniLabel = new St.Label({style_class: 'gnotch-share-mini', y_align: Clutter.ActorAlign.CENTER});
        this.compactRight = new St.Bin({child: this._miniLabel, y_align: Clutter.ActorAlign.CENTER});

        // This computer's LocalSend device (the app's own name and certificate)
        this._localsend = new LocalSend();
        this._localsend.connectObject(
            'peers-changed', () => this._syncDevices(),
            'state-changed', () => this._syncStatus(),
            'request', (_d, session) => this._onRequest(session),
            'session-changed', (_d, session) => this._syncIncoming(session),
            'message', (_d, message) => this._onMessage(message),
            this);

        this._loadHistory().catch(logError);
        this._syncFiles();
        this._syncDevices();
        this._syncStatus();
    }

    // ---- page ----

    _buildPage() {
        this.page = new St.Widget({layout_manager: new Clutter.BinLayout()});
        const content = new St.BoxLayout({
            style_class: 'gnotch-page',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        const header = new St.BoxLayout({style_class: 'gnotch-page-header'});
        header.add_child(new St.Label({text: 'Share', style_class: 'gnotch-page-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const add = new St.Button({style_class: 'button', label: 'Add files…', can_focus: true});
        add.connect('clicked', () => this._command('pick'));
        this._clear = new St.Button({style_class: 'button', label: 'Clear', can_focus: true});
        this._clear.connect('clicked', () => this._clearFiles());
        header.add_child(add);
        header.add_child(this._clear);
        content.add_child(header);
        content.add_child(this._buildIncoming());

        const body = new St.BoxLayout({style_class: 'gnotch-share-body', x_expand: true});
        const [filesCol, filesList, filesEmpty] = this._column('Files', 'Drop files on the notch');
        const [devicesCol, devicesList, devicesEmpty, devicesHeader] = this._column('Nearby devices', 'Looking for LocalSend devices…');
        this._filesList = filesList;
        this._filesEmpty = filesEmpty;
        this._devicesList = devicesList;
        this._devicesEmpty = devicesEmpty;
        const refresh = new St.Button({
            style_class: 'icon-button flat',
            can_focus: true,
            child: new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 16}),
        });
        refresh.connect('clicked', () => this._localsend.announce());
        devicesHeader.add_child(refresh);
        // "Visible as …", or why the notch can't receive
        this._statusLabel = new St.Label({style_class: 'gnotch-share-status'});
        devicesCol.insert_child_at_index(this._statusLabel, 1);

        // Asked for when the other device has a PIN set
        this._pinEntry = new St.Entry({hint_text: 'PIN for this device', can_focus: true, visible: false});
        this._pinEntry.clutter_text.connect('activate', () => {
            const peer = this._pinPeer;
            this._pinEntry.hide();
            if (peer)
                this._send(peer, this._pinEntry.text.trim());
        });
        devicesCol.add_child(this._pinEntry);

        body.add_child(filesCol);
        body.add_child(new St.Widget({style_class: 'gnotch-divider', y_expand: true}));
        body.add_child(devicesCol);
        content.add_child(body);

        this._receivedBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'gnotch-list'});
        const receivedHeader = new St.BoxLayout();
        receivedHeader.add_child(new St.Label({text: 'Received', style_class: 'gnotch-share-caption', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const openFolder = new St.Button({
            style_class: 'button gnotch-share-folder',
            can_focus: true,
            child: new St.BoxLayout({style_class: 'gnotch-share-folder-box'}),
        });
        openFolder.child.add_child(new St.Icon({icon_name: 'folder-open-symbolic', icon_size: 16}));
        openFolder.child.add_child(new St.Label({text: 'Open folder', y_align: Clutter.ActorAlign.CENTER}));
        openFolder.connect('clicked', () => this._openFolder());
        receivedHeader.add_child(openFolder);
        this._receivedBox.add_child(receivedHeader);
        this._receivedEmpty = new St.Label({text: 'Nothing received yet', style_class: 'gnotch-empty', x_align: Clutter.ActorAlign.CENTER});
        this._receivedBox.add_child(this._receivedEmpty);
        this._receivedList = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'gnotch-list'});
        this._receivedBox.add_child(this._receivedList);
        content.add_child(this._receivedBox);

        // Shown while files are dragged over the notch
        this._dropZone = new St.BoxLayout({
            style_class: 'gnotch-share-drop',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        const dropInner = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            style_class: 'gnotch-share-drop-inner',
        });
        dropInner.add_child(new St.Icon({icon_name: 'send-to-symbolic', icon_size: 32}));
        dropInner.add_child(new St.Label({text: 'Drop to send with LocalSend', style_class: 'gnotch-page-title'}));
        this._dropZone.add_child(dropInner);

        this._content = content;
        this.page.add_child(content);
        this.page.add_child(this._dropZone);
    }

    /** The card asking to accept incoming files (or showing a text message). */
    _buildIncoming() {
        this._card = new St.BoxLayout({
            style_class: 'gnotch-share-incoming',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
        });
        const top = new St.BoxLayout({style_class: 'gnotch-share-incoming-top'});
        this._cardIcon = new St.Icon({icon_size: 24, y_align: Clutter.ActorAlign.CENTER});
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._cardTitle = new St.Label({style_class: 'gnotch-row-title'});
        this._cardBody = new St.Label({style_class: 'gnotch-row-body'});
        this._cardBody.clutter_text.line_wrap = true;
        text.add_child(this._cardTitle);
        text.add_child(this._cardBody);
        this._cardButtons = new St.BoxLayout({style_class: 'gnotch-share-incoming-buttons', y_align: Clutter.ActorAlign.CENTER});
        top.add_child(this._cardIcon);
        top.add_child(text);
        top.add_child(this._cardButtons);
        this._card.add_child(top);
        this._cardLevel = new BarLevel({style_class: 'level', x_expand: true, visible: false});
        this._card.add_child(this._cardLevel);
        return this._card;
    }

    /** Replaces the card's buttons: [[label, callback, primary], ...]. */
    _setCardButtons(buttons) {
        this._cardButtons.destroy_all_children();
        for (const [label, callback, primary] of buttons) {
            const button = new St.Button({
                style_class: primary ? 'button gnotch-share-accept' : 'button',
                label,
                can_focus: true,
            });
            button.connect('clicked', callback);
            this._cardButtons.add_child(button);
        }
    }

    _showCard(shown) {
        if (shown === this._card.visible)
            return;
        Anim.setShown(this._card, shown);
        this._notch.refit(this);
    }

    /** A captioned list with an empty-state label; returns [column, list, empty, header]. */
    _column(caption, emptyText) {
        const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'gnotch-share-col'});
        const header = new St.BoxLayout();
        header.add_child(new St.Label({text: caption, style_class: 'gnotch-share-caption', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        col.add_child(header);
        const empty = new St.Label({text: emptyText, style_class: 'gnotch-empty', x_align: Clutter.ActorAlign.CENTER});
        col.add_child(empty);
        const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'gnotch-list'});
        col.add_child(new St.ScrollView({
            child: list,
            x_expand: true,
            height: LIST_HEIGHT,
            hscrollbar_policy: St.PolicyType.NEVER,
        }));
        return [col, list, empty, header];
    }

    onShown() {
        this._localsend.announce();
        Anim.stagger([...this._filesList.get_children(), ...this._devicesList.get_children()],
            {dy: 6, delay: 100, step: 25, duration: 250});
    }

    // ---- files ----

    async _addFiles(paths) {
        const attrs = 'standard::size,standard::display-name,standard::symbolic-icon';
        for (const path of paths) {
            if (this._files.some(f => f.path === path))
                continue;
            const file = Gio.File.new_for_path(path);
            let info;
            try {
                info = await file.query_info_async(attrs, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
            } catch (e) {
                console.warn(`gnotch: can't share ${path}: ${e.message}`);
                continue;
            }
            if (!this._filesList)
                return; // destroyed meanwhile
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                this._notch.peek({iconName: 'folder-symbolic', title: "Folders can't be sent", body: info.get_display_name()});
                continue;
            }
            const entry = {file, path, name: info.get_display_name(), size: info.get_size(), gicon: info.get_symbolic_icon()};
            entry.row = this._fileRow(entry);
            this._files.push(entry);
            this._filesList.add_child(entry.row);
            Anim.rowIn(entry.row);
        }
        this._syncFiles();
    }

    _fileRow(entry) {
        const row = new St.BoxLayout({style_class: 'gnotch-row', x_expand: true});
        row.add_child(new St.Icon({gicon: entry.gicon, icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(new St.Label({text: entry.name, style_class: 'gnotch-row-title'}));
        text.add_child(new St.Label({text: formatSize(entry.size), style_class: 'gnotch-row-body'}));
        row.add_child(text);
        const remove = new St.Button({
            style_class: 'icon-button flat',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 16}),
        });
        remove.connect('clicked', () => {
            this._files = this._files.filter(f => f !== entry);
            Anim.rowOut(row, {dx: 56, onDone: () => this._syncFiles()});
        });
        row.add_child(remove);
        return row;
    }

    _clearFiles() {
        this._files.forEach((f, i) => Anim.rowOut(f.row, {delay: i * 45, dx: 56, onDone: () => this._syncFiles()}));
        this._files = [];
    }

    _syncFiles() {
        if (!this._filesList)
            return;
        Anim.setShown(this._filesEmpty, this._files.length === 0 && this._filesList.get_n_children() === 0);
        this._clear.reactive = this._files.length > 0;
        this._clear.opacity = this._files.length > 0 ? 255 : 128;
    }

    // ---- devices ----

    _syncDevices() {
        if (!this._devicesList)
            return;
        const peers = this._localsend.peers;
        const ids = new Set(peers.map(p => p.fingerprint));
        for (const [id, {row}] of this._deviceRows) {
            if (!ids.has(id) && this._transfer?.peer.fingerprint !== id) {
                this._deviceRows.delete(id);
                Anim.rowOut(row, {dx: 56, onDone: () => this._syncDevicesEmpty()});
            }
        }
        for (const peer of peers) {
            if (this._deviceRows.has(peer.fingerprint))
                continue;
            const entry = this._deviceRow(peer);
            this._deviceRows.set(peer.fingerprint, entry);
            this._devicesList.add_child(entry.row);
            Anim.rowIn(entry.row);
        }
        this._syncDevicesEmpty();
    }

    _syncDevicesEmpty() {
        Anim.setShown(this._devicesEmpty, this._deviceRows.size === 0 && this._devicesList.get_n_children() === 0);
    }

    _deviceRow(peer) {
        const row = new St.BoxLayout({style_class: 'gnotch-row', x_expand: true});
        const button = new St.Button({x_expand: true, can_focus: true, style_class: 'popup-menu-item'});
        const box = new St.BoxLayout();
        const icon = peer.deviceType === 'mobile' ? 'phone-symbolic' : 'computer-symbolic';
        box.add_child(new St.Icon({icon_name: icon, icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(new St.Label({text: peer.alias, style_class: 'gnotch-row-title'}));
        const status = new St.Label({text: peer.deviceModel ?? '', style_class: 'gnotch-row-body'});
        status.visible = !!status.text;
        text.add_child(status);
        box.add_child(text);
        button.child = box;
        button.connect('clicked', () => this._send(peer));

        const cancel = new St.Button({
            style_class: 'icon-button flat',
            can_focus: true,
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'process-stop-symbolic', icon_size: 16}),
        });
        cancel.connect('clicked', () => this._transfer?.cancellable.cancel());

        row.add_child(button);
        row.add_child(cancel);
        return {row, status, cancel, model: peer.deviceModel ?? '', errorId: 0};
    }

    _setDeviceStatus(peer, text) {
        const entry = this._deviceRows.get(peer.fingerprint);
        if (!entry)
            return;
        this._clearDeviceError(entry);
        entry.status.text = text ?? entry.model;
        entry.status.visible = !!entry.status.text;
        entry.cancel.visible = text !== null;
    }

    /** Shows a send's outcome in the device's row for a few seconds (peeks don't show while open). */
    _flashDeviceStatus(peer, message, {error = true} = {}) {
        const entry = this._deviceRows.get(peer.fingerprint);
        if (!entry)
            return;
        this._setDeviceStatus(peer, null);
        entry.status.text = message;
        entry.status.visible = true;
        if (error) {
            entry.status.add_style_class_name('gnotch-share-error');
            Anim.shake(entry.status);
        }
        entry.errorId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ERROR_MS, () => {
            entry.errorId = 0;
            this._setDeviceStatus(peer, null);
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearDeviceError(entry) {
        if (entry.errorId)
            GLib.source_remove(entry.errorId);
        entry.errorId = 0;
        entry.status.remove_style_class_name('gnotch-share-error');
    }

    _syncStatus() {
        const ls = this._localsend;
        const [text, warning] = !ls.ready ? ['Starting LocalSend…', false]
            : ls.receiving ? [`Visible as ${ls.identity.alias}`, false]
                : ['Close the LocalSend app so the notch can receive', true];
        this._statusLabel.text = text;
        if (warning)
            this._statusLabel.add_style_class_name('warning');
        else
            this._statusLabel.remove_style_class_name('warning');
    }

    async _send(peer, pin) {
        if (this._transfer || !this._localsend.ready)
            return;
        if (!this._files.length) {
            Anim.shake(this._filesEmpty);
            return;
        }
        const files = this._files.map(f => f.file);
        const firstName = this._files[0].name;
        const cancellable = new Gio.Cancellable();
        this._transfer = {peer, cancellable, progress: 0};
        this._pinEntry.hide();
        this._setDeviceStatus(peer, `Waiting for ${peer.alias} to accept…`);
        this._notch.updateCompact();
        this._setProgress(0);

        try {
            await this._localsend.send(peer, files, {
                cancellable,
                pin,
                onAccepted: () => this._setDeviceStatus(peer, 'Sending…'),
                onProgress: fraction => this._setProgress(fraction),
            });
            this._notch.peek({
                iconName: 'send-to-symbolic',
                title: `Sent to ${peer.alias}`,
                body: files.length === 1 ? firstName : `${files.length} files`,
            });
            this._clearFiles();
            this._transfer = null;
            this._flashDeviceStatus(peer, 'Sent ✓', {error: false});
        } catch (e) {
            if (e.code === 'pin') {
                this._pinPeer = peer;
                this._pinEntry.text = '';
                this._pinEntry.hint_text = `${e.message} for ${peer.alias}`;
                this._pinEntry.show();
                this._notch.grabKeyboard(this._pinEntry);
            }
            if (this._filesList) {
                this._transfer = null;
                if (e.code === 'pin' || cancellable.is_cancelled())
                    this._setDeviceStatus(peer, null);
                else
                    this._flashDeviceStatus(peer, e.message);
                if (!this._notch.expanded && !cancellable.is_cancelled())
                    this._notch.peek({iconName: 'dialog-warning-symbolic', title: "Couldn't send", body: e.message});
            }
        } finally {
            if (this._filesList) {
                if (this._transfer)
                    this._setDeviceStatus(peer, null);
                this._transfer = null;
                this._notch.updateCompact();
                this._syncDevices();
            }
        }
    }

    _setProgress(fraction) {
        if (!this._transfer)
            return;
        this._transfer.progress = fraction;
        const percent = `${Math.round(fraction * 100)}%`;
        this._setMini('send-to-symbolic', percent);
        if (fraction > 0)
            this._setDeviceStatus(this._transfer.peer, `Sending… ${percent}`);
    }

    _setMini(iconName, text) {
        this.compactLeft.icon_name = iconName;
        if (this._miniLabel.text !== text)
            this._miniLabel.text = text;
    }

    wantsCompact() {
        return !!this._transfer || !!this._incoming;
    }

    /** While someone waits for an answer, opening the notch lands on this tab. */
    wantsFocus() {
        return this._incoming?.state === 'pending';
    }

    // ---- receiving ----

    _onRequest(session) {
        this._incoming = session;
        const n = session.files.length;
        const names = session.files.slice(0, 3).map(f => f.fileName);
        if (n > 3)
            names.push(`+${n - 3} more`);
        const deviceIcon = session.sender.deviceType === 'mobile' ? 'phone-symbolic' : 'computer-symbolic';
        const what = `${n === 1 ? 'a file' : `${n} files`} · ${GLib.format_size(session.totalSize)}`;

        // The same request, as a card on this tab for when the notch is opened
        this._cardIcon.icon_name = deviceIcon;
        this._cardTitle.text = `${session.sender.alias} wants to send ${what}`;
        this._cardBody.text = names.join(', ');
        this._cardLevel.hide();
        this._setCardButtons([
            ['Decline', () => session.decline()],
            ['Accept', () => session.accept(), true],
        ]);
        this._card.show();
        this._notch.refit(this);

        // Asked like an OSD: a peek with round accept / decline buttons
        this._receivingActions = [{iconName: 'process-stop-symbolic', style: 'neutral', onActivate: () => session.cancel()}];
        this._notch.peek({
            key: PEEK_KEY,
            urgent: true,
            force: true,
            sticky: true,
            iconName: deviceIcon,
            title: `${session.sender.alias} wants to send ${what}`,
            body: describeFiles(session.files),
            actions: [
                {iconName: 'window-close-symbolic', style: 'decline', onActivate: () => session.decline()},
                {iconName: 'object-select-symbolic', style: 'accept', onActivate: () => session.accept()},
            ],
        });
        this._setMini('folder-download-symbolic', 'Incoming');
        this._notch.updateCompact();
        global.display.get_sound_player().play_from_theme('message-new-instant', 'LocalSend', null);
    }

    _syncIncoming(session) {
        if (session !== this._incoming)
            return;
        switch (session.state) {
        case 'receiving': {
            const fraction = session.totalSize > 0 ? session.received / session.totalSize : 0;
            const percent = `${Math.round(fraction * 100)}%`;
            if (this._cardLevel.visible && this._miniLabel.text === percent)
                return; // chunks arrive often; redraw on whole percents only
            this._cardTitle.text = `Receiving from ${session.sender.alias}`;
            this._cardLevel.show();
            this._cardLevel.value = fraction;
            this._setCardButtons([['Cancel', () => session.cancel()]]);
            this._setMini('folder-download-symbolic', percent);
            // The request peek turns into a progress meter
            this._notch.updatePeek({
                key: PEEK_KEY,
                sticky: true,
                iconName: 'folder-download-symbolic',
                title: `Receiving from ${session.sender.alias}`,
                body: describeFiles(session.files),
                level: fraction,
                actions: this._receivingActions,
            });
            break;
        }
        case 'done': {
            this._finishIncoming();
            const n = session.saved.length;
            this._addHistory(session.saved.map(f => ({
                name: f.get_basename(), path: f.get_path(), sender: session.sender.alias, time: Date.now(),
            })));
            const done = {
                key: PEEK_KEY,
                iconName: 'object-select-symbolic',
                title: `Received from ${session.sender.alias}`,
                body: n === 1 ? session.saved[0].get_basename() : `${n} files in ${GLib.path_get_basename(this._localsend.identity.destination)}`,
                actions: [],
            };
            if (!this._notch.updatePeek(done))
                this._notch.peek(done);
            break;
        }
        case 'cancelled': {
            this._finishIncoming();
            const cancelled = {
                key: PEEK_KEY,
                iconName: 'dialog-warning-symbolic',
                title: 'Transfer cancelled',
                body: session.sender.alias,
                actions: [],
            };
            if (!this._notch.updatePeek(cancelled))
                this._notch.peek(cancelled);
            break;
        }
        case 'declined':
            this._finishIncoming();
            this._notch.endPeek(PEEK_KEY);
            break;
        }
    }

    _finishIncoming() {
        this._incoming = null;
        this._receivingActions = null;
        this._showCard(false);
        this._notch.updateCompact();
    }

    /** A text sent from another device: a peek with a copy button. */
    _onMessage({sender, text}) {
        this._notch.peek({
            key: `${PEEK_KEY}-message`,
            force: true,
            duration: MESSAGE_PEEK_MS,
            iconName: 'mail-unread-symbolic',
            title: `Message from ${sender.alias}`,
            body: text.replace(/\s+/g, ' '),
            actions: [{
                iconName: 'edit-copy-symbolic',
                style: 'neutral',
                onActivate: () => {
                    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
                    this._notch.endPeek(`${PEEK_KEY}-message`);
                },
            }],
        });
        global.display.get_sound_player().play_from_theme('message-new-instant', 'LocalSend', null);
    }

    _openFolder() {
        const dir = this._localsend.identity?.destination ??
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
        this._notch.collapse();
        const context = global.create_app_launch_context(0, -1);
        Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(dir).get_uri(), context);
    }

    // ---- dropped files ----

    // While files are dragged, Mutter offers the drag data as the DND
    // selection, so the Shell can read the file list itself; no window
    // has to receive the drop.
    _readDraggedFiles() {
        const selection = global.display.get_selection();
        const type = Meta.SelectionType.SELECTION_DND;
        if (!selection.get_mimetypes(type).includes('text/uri-list'))
            return Promise.resolve([]);
        const stream = Gio.MemoryOutputStream.new_resizable();
        return new Promise(resolve => {
            selection.transfer_async(type, 'text/uri-list', -1, stream, null, (_s, res) => {
                try {
                    selection.transfer_finish(res);
                    stream.close(null);
                    const text = this._decoder.decode(stream.steal_as_bytes().get_data() ?? new Uint8Array());
                    resolve(text.split(/\r?\n/)
                        .filter(line => line && !line.startsWith('#'))
                        .map(uri => Gio.File.new_for_uri(uri.trim()).get_path())
                        .filter(Boolean));
                } catch (e) {
                    console.warn(`gnotch: can't read the dragged files: ${e.message}`);
                    resolve([]);
                }
            });
        });
    }

    // Called by the notch while files are dragged over it
    dragEnter() {
        Anim.setShown(this._dropZone, true);
        this._content.ease({opacity: 60, duration: 150});
        // Read now: the selection is gone once the drag ends
        this._dragged = this._readDraggedFiles();
    }

    /** @param {boolean} dropped - released over the notch */
    async dragEnd(dropped) {
        Anim.setShown(this._dropZone, false);
        this._content.ease({opacity: 255, duration: 200});
        const paths = await this._dragged;
        this._dragged = null;
        if (!dropped || !this._filesList)
            return;
        if (!paths?.length) {
            console.warn('gnotch: files were dropped on the notch but no file paths came with them');
            Anim.shake(this._filesEmpty);
            return;
        }
        this._notch.selectWidget(this);
        await this._addFiles(paths);
        this._notch.refit(this);
    }

    // ---- "Add files…": a GTK file chooser in a helper process ----

    _startHelper() {
        try {
            const script = GLib.build_filenamev([this._notch.extensionPath, 'helper', 'gnotch-drop.js']);
            this._helper = Gio.Subprocess.new(['gjs', '-m', script],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
        } catch (e) {
            console.warn(`gnotch: file chooser helper: ${e.message}`);
            this._helper = null;
            return;
        }
        this._stdin = this._helper.get_stdin_pipe();
        this._stdout = new Gio.DataInputStream({base_stream: this._helper.get_stdout_pipe()});
        this._helperCancellable = new Gio.Cancellable();
        this._readHelper().catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e);
        });
    }

    async _readHelper() {
        for (;;) {
            const [line] = await this._stdout.read_line_async(GLib.PRIORITY_DEFAULT, this._helperCancellable);
            if (line === null)
                break; // helper exited
            let paths;
            try {
                paths = JSON.parse(this._decoder.decode(line)).files;
            } catch {
                continue;
            }
            if (!Array.isArray(paths) || !paths.length)
                continue;
            // The notch may have closed while the chooser was open
            if (!this._notch.expanded)
                this._notch.expand();
            this._notch.selectWidget(this);
            await this._addFiles(paths);
            this._notch.refit(this);
        }
        this._helper = null;
    }

    _command(cmd) {
        if (!this._helper)
            this._startHelper();
        try {
            this._stdin?.write_all(new TextEncoder().encode(`${cmd}\n`), null);
        } catch (e) {
            console.warn(`gnotch: file chooser helper: ${e.message}`);
        }
    }

    // ---- received history ----

    async _loadHistory() {
        try {
            const [contents] = await this._historyFile.load_contents_async(null);
            const items = JSON.parse(this._decoder.decode(contents));
            if (Array.isArray(items))
                this._history = items.filter(i => typeof i?.path === 'string');
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`gnotch: can't read received files: ${e.message}`);
        }
        this._syncReceived();
    }

    _addHistory(items) {
        this._history = [...items, ...this._history].slice(0, MAX_HISTORY);
        this._syncReceived();
        const dir = this._historyFile.get_parent();
        if (!dir.query_exists(null))
            dir.make_directory_with_parents(null);
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(this._history, null, 2)));
        this._historyFile.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null).catch(logError);
    }

    _syncReceived() {
        if (!this._receivedList)
            return;
        this._receivedList.destroy_all_children();
        for (const item of this._history.slice(0, MAX_RECEIVED))
            this._receivedList.add_child(this._receivedRow(item));
        this._receivedEmpty.visible = this._history.length === 0;
        this._notch.refit(this);
    }

    _receivedRow(item) {
        const button = new St.Button({x_expand: true, can_focus: true, style_class: 'popup-menu-item'});
        const box = new St.BoxLayout();
        const [type] = Gio.content_type_guess(item.name ?? '', null);
        box.add_child(new St.Icon({gicon: Gio.content_type_get_symbolic_icon(type), icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Label({text: item.name ?? '', style_class: 'gnotch-row-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Label({text: item.sender ?? '', style_class: 'gnotch-row-body', y_align: Clutter.ActorAlign.CENTER}));
        button.child = box;
        button.connect('clicked', () => {
            if (!item.path)
                return;
            this._notch.collapse();
            const context = global.create_app_launch_context(0, -1);
            Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(item.path).get_uri(), context);
        });
        return button;
    }

    destroy() {
        this._transfer?.cancellable.cancel();
        this._helperCancellable?.cancel();
        this._command = () => {};
        try {
            this._stdin?.write_all(new TextEncoder().encode('quit\n'), null);
            this._stdin?.close(null);
        } catch {}
        this._helper?.force_exit();
        this._helper = null;
        for (const entry of this._deviceRows.values())
            this._clearDeviceError(entry);
        this._localsend.disconnectObject(this);
        this._localsend.destroy();
        this._deviceRows.clear();
        this._files = [];
        this._filesList = null;
        this._devicesList = null;
        this._receivedList = null;
    }
}
