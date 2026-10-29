// Gnotch's file chooser helper for the Share tab's "Add files…" button.
// GNOME Shell can't show a GTK file dialog itself, so this small GTK app
// does and reports the chosen files on stdout.
//
// stdin commands (one per line): "pick" (file chooser), "quit"
// stdout: one JSON line per result: {"files": ["/path", ...]}

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gtk.FileDialog.prototype, 'open_multiple', 'open_multiple_finish');

const stdout = new GioUnix.OutputStream({fd: 1, close_fd: false});
const stdin = new Gio.DataInputStream({base_stream: new GioUnix.InputStream({fd: 0, close_fd: false})});

function report(files) {
    const paths = files.map(f => f.get_path()).filter(Boolean);
    if (paths.length)
        stdout.write_all(new TextEncoder().encode(`${JSON.stringify({files: paths})}\n`), null);
}

const app = new Gtk.Application({
    application_id: 'io.github.gnotch.Drop',
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});

async function pick() {
    const dialog = new Gtk.FileDialog({title: 'Send with LocalSend', modal: false});
    try {
        const list = await dialog.open_multiple(null, null);
        const files = [];
        for (let i = 0; i < list.get_n_items(); i++)
            files.push(list.get_item(i));
        report(files);
    } catch (e) {
        if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
            logError(e);
    }
}

async function readCommands() {
    for (;;) {
        const [line] = await stdin.read_line_async(GLib.PRIORITY_DEFAULT, null);
        if (line === null)
            break; // the extension went away
        switch (new TextDecoder().decode(line).trim()) {
        case 'pick':
            pick();
            break;
        case 'quit':
            app.quit();
            return;
        }
    }
    app.quit();
}

app.connect('activate', () => {
    // Stay alive without a window, waiting for commands
    app.hold();
    readCommands().catch(e => {
        logError(e);
        app.quit();
    });
});
app.run([]);
