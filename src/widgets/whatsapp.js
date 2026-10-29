import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Anim from '../anim.js';
import {CallAudio} from '../callaudio.js';
import {hostPath} from '../sandbox.js';
import {WhatsAppBridge} from '../whatsapp-bridge.js';

Gio._promisify(Gio.File.prototype, 'copy_async');

// Chrome shows WhatsApp Web notifications as (captured from Chrome 156):
//   summary: the sender ("Rina", or "+62 812-…" when not saved)
//   body:    "web.whatsapp.com\n\n<message or call text>"
//   image:   the sender's avatar, in Chrome's private /tmp
// Incoming calls also carry "Accept" and "Decline" actions.
const ORIGIN = /^web\.whatsapp\.com\s*\n\s*\n?/;
const INCOMING_CALL = /^(Incoming (voice|video) call|Panggilan (suara|video) masuk)/i;
const MISSED_CALL = /^(Missed (voice|video) call|Panggilan (suara|video) tak terjawab)/i;
const ACCEPT = /^(accept|terima)/i;
const DECLINE = /^(decline|tolak)/i;

const AVATAR_DIR = [GLib.get_user_cache_dir(), 'gnotch', 'whatsapp'];
const MESSAGE_PEEK_MS = 5000;
const CALL_TIMEOUT_MS = 60000; // a ringing peek never outlives this
const ANSWERED_PEEK_MS = 4000;
// A call found in Chrome's audio counts as WhatsApp's if it rang this recently
const CALL_CONTEXT_MS = 90000;
const CONNECT_TIMEOUT_MS = 10000; // accepted but no call audio: say it's in Chrome
const ENDED_PEEK_MS = 3000;
// Glow colours, as in the stylesheet: calls are green, missed calls red
const CALL_GLOW = '#57e389';
const MISSED_GLOW = '#f66151';
const NOTE_MS = 5000; // a hang-up hint replaces the timer this long
const IN_CALL_KEY = 'wa-in-call';
const PAIR_KEY = 'wa-pair';
const WAVE_SHAPE = [0.55, 0.85, 1, 0.75, 0.5]; // middle bars swing higher

function formatElapsed(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = String(Math.floor(seconds % 60)).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** A few bars that jump with a voice's loudness. */
class VoiceWave {
    constructor(styleClass) {
        this.actor = new St.BoxLayout({style_class: `gnotch-wave ${styleClass}`, y_align: Clutter.ActorAlign.CENTER});
        this._bars = WAVE_SHAPE.map(() => {
            const bar = new St.Widget({style_class: 'gnotch-wave-bar', y_align: Clutter.ActorAlign.CENTER, height: 3});
            this.actor.add_child(bar);
            return bar;
        });
    }

    /** @param {number} level - 0..1 */
    setLevel(level) {
        const t = GLib.get_monotonic_time() / 90000;
        this._bars.forEach((bar, i) => {
            // A little wobble per bar so speech doesn't look like a block
            const wobble = 0.65 + 0.35 * Math.abs(Math.sin(t + i * 1.7));
            bar.ease({
                height: Math.round(3 + 15 * level * WAVE_SHAPE[i] * wobble),
                duration: 80,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
    }

    destroy() {
        this.actor.destroy();
    }
}

/** {kind, sender, text, video} for a WhatsApp Web notification from Chrome, else null. */
export function parseWhatsApp(source, notification) {
    const app = source?.app?.get_id?.() ?? '';
    const fromChrome = source?.title === 'Google Chrome' || /chrome/i.test(app);
    const body = notification.body ?? '';
    if (!fromChrome || !ORIGIN.test(body))
        return null;
    const text = body.replace(ORIGIN, '').trim();
    const sender = notification.title ?? '';
    const video = /video/i.test(text);
    if (INCOMING_CALL.test(text) || notification.actions?.some(a => ACCEPT.test(a.label)))
        return {kind: 'call', sender, text, video};
    if (MISSED_CALL.test(text))
        return {kind: 'missed', sender, text, video};
    return {kind: 'message', sender, text, video: false};
}

export class WhatsAppWidget {
    constructor(notch) {
        this._notch = notch;
        this._unread = new Map(); // sender -> count since the last peek ended
        this._ringing = new Set(); // incoming-call notifications we watch
        this._timers = new Set(); // one-shot timeouts, removed on destroy
        this._avatarDir = Gio.File.new_for_path(GLib.build_filenamev(AVATAR_DIR));
        this._expecting = null; // the call that rang: {sender, cover, video, until}
        this._call = null; // the call in progress

        // The Chrome extension presses WhatsApp's own buttons (hang up...)
        this._bridge = new WhatsAppBridge(notch.settings);
        this._bridge.connectObject(
            'pair-request', (_b, request) => this._askToPair(request),
            'pair-cancelled', () => this._notch.endPeek(PAIR_KEY),
            'event', (_b, event) => this._onExtensionEvent(event),
            this);

        // Chrome records from the microphone exactly while a call is connected
        this._audio = new CallAudio();
        this._audio.connectObject(
            'active-changed', (_a, active) => this._onCallAudio(active),
            'levels', (_a, levels) => {
                this._call?.theirs.setLevel(levels.theirs);
                this._call?.mine.setLevel(levels.mine);
            }, this);

        // Compact pill during a call: green phone left, timer right
        // The notch fades compactLeft in and out; the breathing runs on the
        // inner bin so the two animations never fight over one actor
        this._callIcon = new St.Icon({icon_name: 'call-start-symbolic', icon_size: 16, style_class: 'gnotch-call-icon'});
        this._callGlow = new St.Bin({child: this._callIcon});
        this.compactLeft = new St.Bin({child: this._callGlow});
        this._callLabel = new St.Label({style_class: 'gnotch-call-mini', y_align: Clutter.ActorAlign.CENTER});
        this.compactRight = new St.Bin({child: this._callLabel, y_align: Clutter.ActorAlign.CENTER});

        for (const source of Main.messageTray.getSources())
            this._watchSource(source);
        Main.messageTray.connectObject('source-added', (_t, source) => this._watchSource(source), this);
    }

    /** Runs callback once after ms; destroy() removes it if still pending. */
    _after(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    /** The notifications widget leaves these to us (no double peek). */
    claimsNotification(source, notification) {
        return !!parseWhatsApp(source, notification);
    }

    _watchSource(source) {
        source.connectObject('notification-added', (src, notification) => {
            const wa = parseWhatsApp(src, notification);
            if (!wa)
                return;
            // The notch shows it instead of GNOME's banner. This runs before the
            // source asks for a banner, and acknowledged ones never get one.
            // The notification stays in the list (and Chrome keeps its actions).
            notification.acknowledged = true;
            this._onWhatsApp(notification, wa).catch(logError);
        }, this);
    }

    async _onWhatsApp(notification, wa) {
        // Chrome deletes the avatar with the notification: keep a copy per sender
        const avatar = await this._saveAvatar(notification, wa.sender);
        if (!this._avatarDir)
            return; // destroyed meanwhile
        const cover = avatar ? {url: avatar, fallback: 'avatar-default-symbolic'} : null;
        switch (wa.kind) {
        case 'call':
            this._showCall(notification, wa, cover);
            break;
        case 'missed':
            this._notch.peek({
                key: `wa-call:${wa.sender}`,
                cover,
                iconName: 'call-missed-symbolic',
                glowColor: MISSED_GLOW,
                title: wa.sender,
                body: wa.text,
                actions: [this._openAction(notification)],
            });
            break;
        default:
            this._showMessage(notification, wa, cover);
        }
    }

    _showMessage(notification, wa, cover) {
        const count = (this._unread.get(wa.sender) ?? 0) + 1;
        this._unread.set(wa.sender, count);
        const key = `wa:${wa.sender}`;
        this._notch.peek({
            key,
            cover,
            iconName: 'chat-message-new-symbolic',
            title: count > 1 ? `${wa.sender} · ${count} new` : wa.sender,
            body: wa.text,
            duration: MESSAGE_PEEK_MS,
            actions: [this._openAction(notification, key)],
        });
        // Count again from one once this burst of messages has been seen
        this._after(MESSAGE_PEEK_MS, () => {
            if (this._unread.get(wa.sender) === count)
                this._unread.delete(wa.sender);
        });
    }

    _showCall(notification, wa, cover) {
        const key = `wa-call:${wa.sender}`;
        const action = re => notification.actions?.find(a => re.test(a.label));
        const kind = wa.video ? 'video call' : 'voice call';
        this._expecting = {sender: wa.sender, cover, video: wa.video, until: Date.now() + CALL_CONTEXT_MS};
        this._notch.peek({
            key,
            urgent: true,
            force: true,
            sticky: true,
            cover,
            iconName: 'call-incoming-symbolic',
            glow: 'loop', // a line keeps circling while it rings
            glowColor: CALL_GLOW,
            title: wa.sender,
            body: `Incoming ${kind}`,
            actions: [
                {iconName: 'call-stop-symbolic', style: 'decline', onActivate: () => {
                    action(DECLINE)?.activate();
                    this._notch.endPeek(key);
                }},
                {iconName: wa.video ? 'camera-web-symbolic' : 'call-start-symbolic', style: 'accept', onActivate: () => {
                    this._answering = key;
                    action(ACCEPT)?.activate();
                    // Chrome connects the call; its audio switches the notch to the call
                    this._notch.updatePeek({
                        key,
                        sticky: true,
                        cover,
                        iconName: 'call-start-symbolic',
                        title: wa.sender,
                        body: 'Connecting…',
                        glow: 'loop',
                        glowColor: CALL_GLOW,
                        actions: [],
                    });
                    this._after(CONNECT_TIMEOUT_MS, () => {
                        if (!this._call && this._answering === key) {
                            // No call audio showed up: don't leave "Connecting…" behind
                            this._answering = null;
                            const answered = {
                                key,
                                cover,
                                iconName: 'call-start-symbolic',
                                title: wa.sender,
                                body: `${kind[0].toUpperCase()}${kind.slice(1)} answered in Chrome`,
                                glow: 'hold',
                                glowColor: CALL_GLOW,
                                duration: ANSWERED_PEEK_MS,
                                actions: [],
                            };
                            if (!this._notch.updatePeek(answered))
                                this._notch.endPeek(key);
                        }
                    });
                    if (this._audio.active)
                        this._onCallAudio(true);
                }},
            ],
        });
        // Caller hung up or answered elsewhere: Chrome withdraws the notification
        this._ringing.add(notification);
        notification.connectObject('destroy', () => {
            this._ringing.delete(notification);
            this._endRinging(key);
        }, this);
        this._after(CALL_TIMEOUT_MS, () => this._endRinging(key));
    }

    /** Ends the call peek only while it still asks to accept (not once answered). */
    _endRinging(key) {
        if (this._answering === key)
            return;
        if (this._notch.currentPeek?.key === key && this._notch.currentPeek.sticky)
            this._notch.endPeek(key);
    }

    // ---- Chrome extension ----

    /** An unpaired Gnotch Chrome extension wants to control WhatsApp Web. */
    _askToPair(request) {
        this._notch.peek({
            key: PAIR_KEY,
            urgent: true,
            force: true,
            sticky: true,
            iconName: 'web-browser-symbolic',
            title: 'Pair the Gnotch Chrome extension?',
            body: 'Lets the notch hang up WhatsApp calls',
            actions: [
                {iconName: 'window-close-symbolic', style: 'decline', onActivate: () => {
                    request.decline();
                    this._notch.endPeek(PAIR_KEY);
                }},
                {iconName: 'object-select-symbolic', style: 'accept', onActivate: () => {
                    request.accept();
                    this._notch.updatePeek({
                        key: PAIR_KEY,
                        iconName: 'object-select-symbolic',
                        title: 'Chrome extension paired',
                        body: 'Hang up from the notch during WhatsApp calls',
                        actions: [],
                    });
                }},
            ],
        });
    }

    _onExtensionEvent(event) {
        // The extension sees the call screen itself: the most reliable end signal
        if (event.type === 'call' && event.state === 'ended' && this._call)
            this._endCall();
    }

    // ---- in a call ----

    _onCallAudio(active) {
        if (active && !this._call && this._expecting && Date.now() < this._expecting.until)
            this._startCall(this._expecting);
        else if (!active && this._call)
            this._endCall();
    }

    _startCall({sender, cover, video}) {
        this._notch.endPeek(`wa-call:${sender}`);
        this._answering = null;
        this._expecting = null;
        this._call = {
            sender,
            cover,
            video,
            start: GLib.get_monotonic_time(),
            note: null,
            theirs: new VoiceWave('theirs'),
            mine: new VoiceWave('mine'),
        };
        const waves = new St.BoxLayout({style_class: 'gnotch-call-waves', y_align: Clutter.ActorAlign.CENTER});
        waves.add_child(this._call.theirs.actor);
        waves.add_child(this._call.mine.actor);
        this._call.waves = waves;
        this._call.actions = [{iconName: 'call-stop-symbolic', style: 'decline', onActivate: () => this._hangUp()}];
        this._call.timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._syncCall();
            return GLib.SOURCE_CONTINUE;
        });
        Anim.breathe(this._callGlow, true, {low: 120, duration: 1400});
        this._syncCall();
        this._notch.updateCompact();
        this._showCallPeek();
    }

    _elapsed() {
        return formatElapsed((GLib.get_monotonic_time() - this._call.start) / 1e6);
    }

    _callPeek() {
        const call = this._call;
        return {
            key: IN_CALL_KEY,
            force: true,
            sticky: true,
            cover: call.cover,
            iconName: 'call-start-symbolic',
            title: call.sender,
            body: call.note ?? `${call.video ? 'Video call' : 'In call'} · ${this._elapsed()}`,
            glow: 'pulse',
            glowColor: CALL_GLOW,
            extra: call.waves,
            actions: call.actions,
        };
    }

    _showCallPeek() {
        if (this._call)
            this._notch.peek(this._callPeek());
    }

    _syncCall() {
        if (!this._call)
            return;
        this._callLabel.text = this._elapsed();
        this._notch.updatePeek(this._callPeek());
    }

    /** Shows a hint instead of the timer for a few seconds. */
    _note(text) {
        if (!this._call)
            return;
        this._call.note = text;
        this._syncCall();
        this._after(NOTE_MS, () => {
            if (this._call?.note === text) {
                this._call.note = null;
                this._syncCall();
            }
        });
    }

    _hangUp() {
        if (!this._bridge.connected) {
            this._focusWhatsApp();
            this._note('Hang up in Chrome (pair the Chrome extension to do it here)');
            return;
        }
        this._note('Hanging up…');
        this._bridge.request('call', {action: 'hangup'}).catch(e => {
            // The error lists the buttons on screen, to fix whatsapp-dom.js
            console.warn(`gnotch: WhatsApp hang up: ${e.message}`);
            this._focusWhatsApp();
            this._note("Couldn't hang up here; use Chrome");
        });
    }

    _endCall() {
        const call = this._call;
        GLib.source_remove(call.timerId);
        const duration = this._elapsed();
        this._call = null;
        Anim.breathe(this._callGlow, false);
        this._notch.endPeek(IN_CALL_KEY);
        this._notch.updateCompact();
        this._notch.peek({
            key: 'wa-call-ended',
            cover: call.cover,
            iconName: 'call-stop-symbolic',
            title: call.sender,
            body: `Call ended · ${duration}`,
            glow: false,
            duration: ENDED_PEEK_MS,
        });
        call.theirs.destroy();
        call.mine.destroy();
        call.waves.destroy();
    }

    /** Brings the WhatsApp tab forward (through the extension when paired). */
    _focusWhatsApp() {
        if (this._bridge.connected) {
            this._bridge.request('focus').catch(e => console.warn(`gnotch: WhatsApp focus: ${e.message}`));
            return;
        }
        const app = Shell.AppSystem.get_default().lookup_app('com.google.Chrome.desktop');
        const win = app?.get_windows().find(w => /WhatsApp/.test(w.get_title() ?? ''));
        if (win)
            Main.activateWindow(win);
        else
            app?.activate();
    }

    onCollapsed() {
        // The call shows itself again once the notch closes
        this._showCallPeek();
    }

    wantsCompact() {
        return !!this._call;
    }

    get showClockInCompact() {
        return true;
    }

    /** Opens WhatsApp in Chrome on that chat: Chrome's default action does exactly that. */
    _openAction(notification, key) {
        return {
            iconName: 'go-next-symbolic',
            style: 'neutral',
            onActivate: () => {
                notification.activate();
                if (key)
                    this._notch.endPeek(key);
            },
        };
    }

    async _saveAvatar(notification, sender) {
        const path = notification.gicon instanceof Gio.FileIcon ? notification.gicon.get_file().get_path() : null;
        const source = path ? hostPath(path) : null;
        const name = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, sender, -1);
        const target = this._avatarDir.get_child(`${name}.png`);
        if (source) {
            try {
                GLib.mkdir_with_parents(this._avatarDir.get_path(), 0o755);
                await Gio.File.new_for_path(source).copy_async(target,
                    Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT, null, null);
            } catch (e) {
                console.warn(`gnotch: WhatsApp avatar: ${e.message}`);
            }
        }
        // A saved avatar from an earlier message still helps
        return target.query_exists(null) ? target.get_uri() : null;
    }

    destroy() {
        this._timers.forEach(id => GLib.source_remove(id));
        this._timers.clear();
        Main.messageTray.disconnectObject(this);
        for (const source of Main.messageTray.getSources())
            source.disconnectObject(this);
        if (this._call) {
            GLib.source_remove(this._call.timerId);
            this._call.waves.destroy();
            this._call = null;
        }
        this._audio.disconnectObject(this);
        this._audio.destroy();
        this._bridge.disconnectObject(this);
        this._bridge.destroy();
        for (const notification of this._ringing)
            notification.disconnectObject(this);
        this._ringing.clear();
        this._unread.clear();
        this._avatarDir = null;
    }
}
