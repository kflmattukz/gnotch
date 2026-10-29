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

The notch peeks when a track changes, the charger is plugged in or unplugged, the battery drops below 20/10/5 %, a notification arrives (unless Do Not Disturb is on), a drive is mounted or ejected, or a Bluetooth device connects. It also peeks for prayer reminders and prayer times, at the end of each Pomodoro phase, and when files are sent or received.

Look: Gnotch reuses GNOME Shell's own widgets (Quick Settings toggles, the date menu calendar, message-list notification rows, check boxes, the OSD level bar, switches) and the Shell's dark palette with your accent colour, so it reads as part of the top bar in both light and dark mode.

Motion: the notch shape is driven by spring physics (`src/anim.js`), so interrupted transitions keep their momentum. Tabs switch on click with a sliding indicator. Other transitions follow GNOME's restrained timing (about 250 ms ease-out). Animations follow GNOME's *Reduce animation* setting.

Glass: the compact notch is solid black; expanded, it turns into frosted glass rendered by [Blur my Shell](https://extensions.gnome.org/extension/3193/blur-my-shell/) itself (its dynamic pipeline with the top bar's blur settings, through `global.blur_my_shell`), blurring whatever is behind the notch. Without Blur my Shell the notch stays black.

OSD: volume, brightness and keyboard backlight changes show in the notch with a level meter instead of the Shell popup (the Shell popup is still used while the notch is expanded).

Remote album art (e.g. Spotify) is cached in `~/.cache/gnotch/art/`.

## Install

```sh
make install          # copy to ~/.local/share/gnome-shell/extensions/gnotch@mattukz
# or: make link       # symlink the working tree for development
```

Log out and back in (Wayland can't restart the shell in place), then:

```sh
gnome-extensions enable gnotch@mattukz
gnome-extensions prefs gnotch@mattukz
```

## Develop

Test in a nested shell window without logging out:

```sh
sudo dnf install mutter-devkit
make link
make nested           # in the nested shell's terminal: gnome-extensions enable gnotch@mattukz
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
```

Each widget exposes an optional `page` (an expanded tab), `compactLeft`/`compactRight` with `wantsCompact()` (to own the pill), and `destroy()`. It calls `notch.peek({...})` for events and `notch.updateCompact()` when its state changes.
