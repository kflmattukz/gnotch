# Gnotch

A NotchNook-style dynamic notch for GNOME Shell 50.

The notch is a black pill at the top of the screen. When nothing is happening it shows the time. It grows to show what is playing or the battery while charging, briefly "peeks" for events, and opens into a panel when you click it (it closes when the pointer leaves).

| Tab | Content |
| --- | --- |
| Home | Now playing card, plus tiles for battery, Wi-Fi, Bluetooth, to-dos, Pomodoro and the next prayer |
| Prayer times | Today's six times, calculated offline from the coordinates and method set in preferences |
| Pomodoro | Focus/break timer; the compact notch counts down while it runs |
| Share | This computer's LocalSend device, under the LocalSend app's own name and certificate. Drag files onto the notch and click a nearby device to send; incoming files ask Accept/Decline in the notch and land in your LocalSend download folder. Keep the LocalSend app closed: it uses the same port |
| Wi-Fi | Nearby networks; click one to connect |
| Calendar | Month grid; events for the selected day from GNOME's calendar server (Online Accounts / Evolution) |
| To-do | Local task list stored in `~/.local/share/gnotch/todos.json`; `#high#` in a task becomes a badge (`important`, `high`, `mid`, `low`, `info` have their own colours); the pencil edits a task |
| Notifications | The last 30 notifications; click one to open it |
| Drives | Mounted removable drives; click to open, ⏏ to eject |

The notch peeks when a track changes, the charger is plugged in or unplugged, the battery drops below 20/10/5 %, a notification arrives (unless Do Not Disturb is on), a drive is mounted or ejected, or a Bluetooth device connects. Two optional widgets are off by default (turn them on in preferences): **Share**, for LocalSend-compatible file transfer, and **Web chat calls**. With Web chat calls on, WhatsApp Web in Chrome gets its own peeks: messages show the sender's photo and text, and incoming calls can be accepted or declined from the notch (allow notifications for web.whatsapp.com in Chrome). During a call the notch shows the caller, a running timer, a voice wave for each side and a hang-up button. GNOME's own banners for these are skipped. It also peeks for prayer reminders and prayer times, at the end of each Pomodoro phase, and when files are sent or received.

Look: Gnotch reuses GNOME Shell's own widgets (Quick Settings toggles, the date menu calendar, message-list notification rows, check boxes, the OSD level bar, switches) and the Shell's dark palette with your accent colour, so it reads as part of the top bar in both light and dark mode.

Motion: the notch shape is driven by spring physics (`src/anim.js`), so interrupted transitions keep their momentum. Tabs switch on click with a sliding indicator. Other transitions follow GNOME's restrained timing (about 250 ms ease-out). Animations follow GNOME's *Reduce animation* setting.

Glass: the compact notch is solid black; expanded, it turns into frosted glass rendered by [Blur my Shell](https://extensions.gnome.org/extension/3193/blur-my-shell/) itself (its dynamic pipeline with the top bar's blur settings, through `global.blur_my_shell`), blurring whatever is behind the notch. Without Blur my Shell the notch stays black.

Glow: a line of light runs along the notch's edge. It lights up nearest the pointer as you approach, sweeps around once for a notification (then glows softly while it shows), circles in green while a call rings, pulses green during a call, and flashes briefly for volume and brightness changes. Charging glows green, low battery red; everything else uses your accent colour. Both parts can be switched off in preferences. The effect is a Cairo port of [glow-card](https://github.com/mulkatz/glow-card) by Franz Schlögel (MIT).

OSD: volume, brightness and keyboard backlight changes show in the notch with a level meter instead of the Shell popup (the Shell popup is still used while the notch is expanded).

Remote album art (e.g. Spotify) is cached in `~/.cache/gnotch/art/`.

## Install

```sh
make install          # copy to ~/.local/share/gnome-shell/extensions/gnotch@kflmattukz.github.io
# or: make link       # symlink the working tree for development
```

Log out and back in (Wayland can't restart the shell in place), then:

```sh
gnome-extensions enable gnotch@kflmattukz.github.io
gnome-extensions prefs gnotch@kflmattukz.github.io
```

## Develop

Test in a nested shell window without logging out:

```sh
sudo dnf install mutter-devkit
make link
make nested           # in the nested shell's terminal: gnome-extensions enable gnotch@kflmattukz.github.io
make log              # follow shell logs
```

Note: GSettings are shared with your real session, so enabling it in the nested shell also enables it in your real session (it will load at your next login).

## Layout

```
extension.js            enable/disable
prefs.js                preferences window (Adw)
src/notch.js            the pill: compact / peek / expanded states, tabs, animation
src/widgets/*.js        media, prayer, pomodoro, share, battery, network, calendar, todo, notifications, devices
src/praytimes.js        prayer time calculation (PrayTimes.org algorithm)
src/localsend.js        LocalSend v2 device: discovery, sending, HTTPS receiver on port 53317
helper/gnotch-drop.js   GTK file chooser for the Share tab's "Add files…" (drops are read from the DND selection)
src/widgets/whatsapp.js WhatsApp Web peeks and calls (from Chrome's notifications)
src/callaudio.js        notices calls from Chrome's microphone stream; voice levels via parec
src/whatsapp-bridge.js  local WebSocket the Chrome extension pairs with (127.0.0.1, token)
chrome-extension/       companion Chrome extension: presses WhatsApp Web's buttons (hang up)
```

Each widget exposes an optional `page` (an expanded tab), `compactLeft`/`compactRight` with `wantsCompact()` (to own the pill), and `destroy()`. It calls `notch.peek({...})` for events and `notch.updateCompact()` when its state changes.

## WhatsApp hang-up (Chrome extension)

The hang-up button needs the companion extension, because the call runs inside the WhatsApp Web tab:

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `chrome-extension` folder of this repository (after an update, click its reload button).
2. The notch asks **Pair the Gnotch Chrome extension?** Accept it. That's all; the token is exchanged for you.

The extension also tells the notch when WhatsApp's call screen closes, so the call view ends exactly with the call. Pairing by hand still works: copy the token from Gnotch preferences → WhatsApp into the extension's options.
