import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

import * as Anim from '../anim.js';
import {Cover} from '../cover.js';

const DBusProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.freedesktop.DBus'));
const MprisProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.mpris.MediaPlayer2'));
const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.mpris.MediaPlayer2.Player'));

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const EQ_BARS = 4;
const COMPACT_WIDTH = 340; // room for the scrolling title between art and equalizer
// Concentric corners: notch radius minus the padding around the art
const ART_SIZE = 64;
const ART_RADIUS = 14;
const MINI_ART_RADIUS = 6;
const EQ_TICK_MS = 170;
// Middle bars swing higher, like a real spectrum
const EQ_RANGE = [[3, 10], [5, 16], [4, 14], [3, 9]];

class Player {
    constructor(busName, onChanged) {
        this.busName = busName;
        this.title = '';
        this.artists = [];
        this.artUrl = '';
        this.app = null;
        this.identity = '';
        this._onChanged = onChanged;

        this._mpris = new MprisProxy(Gio.DBus.session, busName, MPRIS_PATH, () => this._sync());
        this._player = new PlayerProxy(Gio.DBus.session, busName, MPRIS_PATH, (proxy, error) => {
            if (error) {
                console.warn(`gnotch: ${busName}: ${error.message}`);
                return;
            }
            this._player.connectObject('g-properties-changed', () => this._sync(), this);
            this._sync();
        });
    }

    get status() {
        return this._player?.PlaybackStatus ?? 'Stopped';
    }

    get playing() {
        return this.status === 'Playing';
    }

    get canPlay() {
        return !!this._player?.CanPlay;
    }

    get canGoNext() {
        return !!this._player?.CanGoNext;
    }

    get canGoPrevious() {
        return !!this._player?.CanGoPrevious;
    }

    playPause() {
        this._player.PlayPauseAsync().catch(logError);
    }

    next() {
        this._player.NextAsync().catch(logError);
    }

    previous() {
        this._player.PreviousAsync().catch(logError);
    }

    raise() {
        if (this.app)
            this.app.activate();
        else if (this._mpris?.CanRaise)
            this._mpris.RaiseAsync().catch(logError);
    }

    _sync() {
        if (!this._player)
            return;
        const metadata = {};
        for (const key in this._player.Metadata ?? {})
            metadata[key] = this._player.Metadata[key].deepUnpack();

        // Some players send malformed metadata, so validate everything
        const artists = metadata['xesam:artist'];
        this.artists = Array.isArray(artists) ? artists.filter(a => typeof a === 'string') : [];
        this.title = typeof metadata['xesam:title'] === 'string' ? metadata['xesam:title'] : '';
        this.artUrl = typeof metadata['mpris:artUrl'] === 'string' ? metadata['mpris:artUrl'] : '';
        this.identity = this._mpris?.Identity ?? '';

        const entry = this._mpris?.DesktopEntry;
        this.app = entry
            ? Shell.AppSystem.get_default().lookup_app(`${entry}.desktop`)
            : null;

        this._onChanged(this);
    }

    destroy() {
        this._player?.disconnectObject(this);
        this._player = null;
        this._mpris = null;
    }
}

export class MediaWidget {
    constructor(notch) {
        this._notch = notch;
        this._players = new Map();
        this._active = null;
        this._lastTrack = '';
        this._shownTrack = null;
        this._skipDirection = 1;
        this._eqTimeout = 0;
        this._compactVisible = false;

        this._buildCompact();
        this._buildPage();

        this._bus = new DBusProxy(Gio.DBus.session, 'org.freedesktop.DBus',
            '/org/freedesktop/DBus', () => this._onBusReady().catch(logError));
    }

    // ---- UI ----

    _buildCompact() {
        this._miniArt = new Cover({size: 20, radius: MINI_ART_RADIUS});
        this.compactLeft = new St.Bin({child: this._miniArt.actor, y_align: Clutter.ActorAlign.CENTER});

        // Track title between the art and the equalizer
        this._compactTitle = new Anim.Marquee('gnotch-compact-title');
        this.compactCenter = this._compactTitle.actor;
        this.compactWidth = COMPACT_WIDTH;

        this.compactRight = new St.BoxLayout({
            style_class: 'gnotch-eq',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._eqBars = [];
        for (let i = 0; i < EQ_BARS; i++) {
            const bar = new St.Widget({
                style_class: 'gnotch-eq-bar',
                y_align: Clutter.ActorAlign.CENTER,
                height: 3,
            });
            this.compactRight.add_child(bar);
            this._eqBars.push(bar);
        }
    }

    _buildPage() {
        // Card: [art | title/artist | waveform] on top, centered transport controls below
        this.page = new St.BoxLayout({
            style_class: 'gnotch-media',
            orientation: Clutter.Orientation.VERTICAL,
        });

        const top = new St.BoxLayout({style_class: 'gnotch-media-top'});
        // button (hover/press motion) > frame (paused dimming) > art (track swaps)
        this._art = new Cover({size: ART_SIZE, radius: ART_RADIUS});
        this._artFrame = new St.Bin({child: this._art.actor});
        this._artFrame.set_pivot_point(0.5, 0.5);
        const artButton = new St.Button({child: this._artFrame, style_class: 'gnotch-media-art-button'});
        Anim.addButtonMotion(artButton, {hover: 1.04, press: 0.94});
        artButton.connect('clicked', () => this._active?.raise());
        top.add_child(artButton);

        const info = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'gnotch-media-info',
        });
        this._appLabel = new St.Label({style_class: 'gnotch-media-app'});
        this._titleLabel = new St.Label({style_class: 'gnotch-media-title'});
        this._artistLabel = new St.Label({style_class: 'gnotch-media-artist'});
        for (const label of [this._titleLabel, this._artistLabel, this._appLabel])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        info.add_child(this._appLabel);
        info.add_child(this._titleLabel);
        info.add_child(this._artistLabel);
        top.add_child(info);

        // Larger copy of the pill's equalizer, driven by the same ticks
        const wave = new St.BoxLayout({style_class: 'gnotch-eq gnotch-eq-large', y_align: Clutter.ActorAlign.CENTER});
        for (let i = 0; i < EQ_BARS; i++) {
            const bar = new St.Widget({style_class: 'gnotch-eq-bar', y_align: Clutter.ActorAlign.CENTER, height: 3});
            wave.add_child(bar);
            this._eqBars.push(bar);
        }
        top.add_child(wave);
        this.page.add_child(top);

        const controls = new St.BoxLayout({
            style_class: 'gnotch-media-controls',
            x_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._prev = this._makeControl('media-skip-backward-symbolic', () => {
            this._skipDirection = -1;
            Anim.nudge(this._prev.child, {dx: -5});
            this._active?.previous();
        });
        this._playPause = this._makeControl('media-playback-start-symbolic', () => this._active?.playPause());
        this._next = this._makeControl('media-skip-forward-symbolic', () => {
            this._skipDirection = 1;
            Anim.nudge(this._next.child, {dx: 5});
            this._active?.next();
        });
        this._playPause.add_style_class_name('primary');
        this._playPause.child.icon_size = 22;
        controls.add_child(this._prev);
        controls.add_child(this._playPause);
        controls.add_child(this._next);
        this.page.add_child(controls);

        this.page.connect('notify::mapped', () => this._syncEqualizer());
        this._sync();
    }

    _makeControl(iconName, callback) {
        const button = new St.Button({
            style_class: 'gnotch-media-button',
            can_focus: true,
            child: new St.Icon({icon_name: iconName, icon_size: 18}),
        });
        Anim.addButtonMotion(button, {hover: 1.1, press: 0.82});
        button.connect('clicked', callback);
        return button;
    }

    _cover(player) {
        return {
            url: player?.artUrl || null,
            fallback: player?.app?.get_icon() ?? new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'}),
        };
    }

    // ---- players ----

    async _onBusReady() {
        const [names] = await this._bus.ListNamesAsync();
        if (!this._bus)
            return; // destroyed meanwhile
        for (const name of names) {
            if (name.startsWith(MPRIS_PREFIX))
                this._addPlayer(name);
        }
        this._nameOwnerId = this._bus.connectSignal('NameOwnerChanged',
            (_p, _s, [name, oldOwner, newOwner]) => {
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            });
    }

    _addPlayer(busName) {
        if (this._players.has(busName))
            return;
        this._players.set(busName, new Player(busName, p => this._onPlayerChanged(p)));
    }

    _removePlayer(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;
        player.destroy();
        this._players.delete(busName);
        if (this._active === player)
            this._active = null;
        this._pickActive();
    }

    _onPlayerChanged(player) {
        // A player that starts playing takes over
        if (player.playing && this._active !== player && !this._active?.playing)
            this._active = player;
        this._pickActive();

        const track = `${player.title}\u0000${player.artists.join(', ')}`;
        if (player === this._active && player.playing && player.title && track !== this._lastTrack) {
            this._lastTrack = track;
            this._notch.peek({
                cover: this._cover(player),
                title: player.title,
                body: player.artists.join(', '),
            });
        }
    }

    _pickActive() {
        const players = [...this._players.values()].filter(p => p.canPlay);
        if (!this._active || !players.includes(this._active))
            this._active = players.find(p => p.playing) ?? players[0] ?? null;
        this._sync();
        this._notch.updateCompact();
    }

    _sync() {
        const p = this._active;
        const track = p ? `${p.busName}\u0000${p.title}\u0000${p.artists.join(', ')}\u0000${p.artUrl}` : '';

        if (track !== this._shownTrack) {
            const first = this._shownTrack === null;
            this._shownTrack = track;
            const apply = () => {
                const q = this._active;
                this._art.set(this._cover(q));
                this._titleLabel.text = q?.title || (q ? q.identity : 'Nothing playing');
                this._artistLabel.text = q?.artists.join(', ') ?? '';
                this._appLabel.text = q ? (q.app?.get_name() ?? q.identity) : '';
            };
            // Art and text slide over together, in the direction of the skip
            if (first)
                apply();
            else
                Anim.slideSwap([this._titleLabel, this._artistLabel, this._appLabel],
                    apply, {dx: 18 * this._skipDirection});
            if (!first)
                Anim.nudge(this._art.actor, {dx: -8 * this._skipDirection});
            this._skipDirection = 1;
            this._miniArt.set(this._cover(p));
            this._compactTitle.text = p?.title || p?.identity || '';
        }

        Anim.swapIcon(this._playPause.child, {
            icon_name: p?.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
        });
        this._playPause.reactive = !!p;
        this._prev.reactive = !!p?.canGoPrevious;
        this._next.reactive = !!p?.canGoNext;

        // Paused art recedes a little, playing art springs forward
        const playing = !!p?.playing;
        if (playing !== this._artPlaying) {
            this._artPlaying = playing;
            this._artFrame.ease({
                scale_x: playing ? 1 : 0.88,
                scale_y: playing ? 1 : 0.88,
                opacity: playing ? 255 : 170,
                duration: playing ? 620 : 420,
                mode: playing ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_QUINT,
            });
        }
        this._syncEqualizer();
    }

    // ---- compact ----

    wantsCompact() {
        return !!this._active?.playing;
    }

    onCompactVisible(visible) {
        this._compactVisible = visible;
        this._syncEqualizer();
    }

    _tickEqualizer() {
        this._eqBars.forEach((bar, i) => {
            const [min, max] = EQ_RANGE[i % EQ_RANGE.length];
            const scale = i >= EQ_BARS ? 1.5 : 1; // the Home card's copy is taller
            bar.ease({
                height: Math.round((min + Math.random() * (max - min)) * scale),
                // Uneven timing per bar keeps the motion organic
                duration: 140 + Math.round(Math.random() * 140),
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            });
        });
    }

    _syncEqualizer() {
        const animate = (this._compactVisible || this.page.mapped) && !!this._active?.playing;
        if (animate && !this._eqTimeout) {
            this._tickEqualizer();
            this._eqTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EQ_TICK_MS, () => {
                this._tickEqualizer();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!animate && this._eqTimeout) {
            GLib.source_remove(this._eqTimeout);
            this._eqTimeout = 0;
            // Bars settle down one after another
            this._eqBars.forEach((bar, i) => bar.ease({
                height: 3,
                delay: i * 40,
                duration: 360,
                mode: Clutter.AnimationMode.EASE_OUT_QUINT,
            }));
        }
    }

    destroy() {
        this._art.destroy();
        this._miniArt.destroy();
        if (this._eqTimeout)
            GLib.source_remove(this._eqTimeout);
        this._eqTimeout = 0;
        if (this._nameOwnerId)
            this._bus.disconnectSignal(this._nameOwnerId);
        this._bus = null;
        for (const player of this._players.values())
            player.destroy();
        this._players.clear();
    }
}
