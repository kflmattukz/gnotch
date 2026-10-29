import GLib from 'gi://GLib';

/**
 * Finds a Flatpak app's /tmp file on the host. Sandboxed apps (e.g. Chrome)
 * hand out paths in their private /tmp, which the host sees at
 * $XDG_RUNTIME_DIR/.flatpak/<app-id>/tmp. Not every app says which one it
 * is, so every sandbox is checked.
 *
 * @param {string} path - a path as the app reported it
 * @returns {string|null} a path that exists on the host, or null
 */
// shortcut: sync stats on tmpfs (fast, local); go async if this ever touches slow storage
export function hostPath(path) {
    if (GLib.file_test(path, GLib.FileTest.EXISTS))
        return path;
    if (!path.startsWith('/tmp/'))
        return null;
    const sandboxes = GLib.build_filenamev([GLib.get_user_runtime_dir(), '.flatpak']);
    try {
        const dir = GLib.Dir.open(sandboxes, 0);
        for (let name; (name = dir.read_name()) !== null;) {
            const candidate = GLib.build_filenamev([sandboxes, name, path]);
            if (GLib.file_test(candidate, GLib.FileTest.EXISTS))
                return candidate;
        }
    } catch {
        // no Flatpak runtime dir
    }
    return null;
}
