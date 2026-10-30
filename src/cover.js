// Rounded album art that keeps its aspect ratio (scaled to cover, never
// stretched) and crossfades between tracks.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
// The finish function of replace_contents_bytes_async is replace_contents_finish
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_at_scale_async', 'new_from_stream_finish');

const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnotch', 'art']);
const CROSSFADE_MS = 250;

/**
 * CSS images load synchronously, so remote art is downloaded to a local
 * cache first to keep the compositor from blocking on the network.
 *
 * @param {string} url
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<string>} a file:// URI
 */
async function resolveLocal(url, cancellable) {
    if (url.startsWith('file://'))
        return url;
    if (!/^https?:\/\//.test(url))
        throw new Error(`unsupported art URL ${url}`);

    const name = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1);
    const dest = Gio.File.new_for_path(GLib.build_filenamev([CACHE_DIR, name]));
    try {
        await dest.query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable);
        return dest.get_uri(); // already cached
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw e;
    }

    const [bytes] = await Gio.File.new_for_uri(url).load_contents_async(cancellable);
    GLib.mkdir_with_parents(CACHE_DIR, 0o755);
    await dest.replace_contents_bytes_async(new GLib.Bytes(bytes), null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
    return dest.get_uri();
}

/**
 * The art's most vivid average colour, for the panel's ambient tint.
 *
 * @param {string} url - art URL (file:// or http(s)://)
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<number[]>} [r, g, b] 0..255
 */
export async function dominantColor(url, cancellable = null) {
    const uri = await resolveLocal(url, cancellable);
    const stream = await Gio.File.new_for_uri(uri).read_async(GLib.PRIORITY_DEFAULT, cancellable);
    const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, 16, 16, false, cancellable);
    stream.close(null);
    const bytes = pixbuf.get_pixels();
    const stride = pixbuf.get_rowstride();
    const channels = pixbuf.get_n_channels();
    // Saturated pixels count more, so a grey background doesn't wash the colour out
    const sum = [0, 0, 0];
    let total = 0;
    for (let y = 0; y < pixbuf.get_height(); y++) {
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const i = y * stride + x * channels;
            const [r, g, b] = [bytes[i], bytes[i + 1], bytes[i + 2]];
            const weight = 0.05 + (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
            sum[0] += r * weight;
            sum[1] += g * weight;
            sum[2] += b * weight;
            total += weight;
        }
    }
    return sum.map(c => Math.round(c / total));
}

export class Cover {
    /**
     * @param {object} params
     * @param {number} params.size - edge length in px
     * @param {number} params.radius - corner radius in px
     */
    constructor({size, radius}) {
        this._size = size;
        this._radius = radius;
        this._key = null;
        this._front = 0;
        this._cancellable = null;

        this.actor = new St.Widget({
            style_class: 'gnotch-cover',
            layout_manager: new Clutter.BinLayout(),
            width: size,
            height: size,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._layers = [this._makeLayer(), this._makeLayer()];
        this._layers.forEach(l => this.actor.add_child(l));
        this._layers[1].opacity = 0;
    }

    _makeLayer() {
        const layer = new St.Bin({
            x_expand: true,
            y_expand: true,
            child: new St.Icon({
                style_class: 'gnotch-cover-fallback',
                icon_size: Math.round(this._size * 0.55),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }),
        });
        layer.set_pivot_point(0.5, 0.5);
        return layer;
    }

    /**
     * @param {object} p
     * @param {string} [p.url] - art URL (file:// or http(s)://)
     * @param {Gio.Icon} [p.fallback] - shown when there is no art
     */
    set({url, fallback}) {
        const key = url || fallback?.to_string() || '';
        if (key === this._key)
            return;
        this._key = key;

        this._cancellable?.cancel();
        this._cancellable = null;
        if (!url) {
            this._show({gicon: fallback});
            return;
        }

        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        resolveLocal(url, cancellable)
            .then(uri => this._show({uri}))
            .catch(e => {
                if (cancellable.is_cancelled())
                    return;
                console.debug(`gnotch: album art: ${e.message}`);
                this._show({gicon: fallback});
            });
    }

    _show({uri, gicon}) {
        if (!this.actor)
            return;
        const front = this._layers[this._front];
        const back = this._layers[1 - this._front];

        const radius = `border-radius: ${this._radius}px;`;
        back.style = uri
            ? `${radius} background-image: url("${uri.replace(/"/g, '%22')}"); background-size: cover;`
            : `${radius} background-color: rgba(255, 255, 255, 0.1);`;
        back.child.visible = !uri;
        back.child.gicon = gicon ?? new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});

        this._front = 1 - this._front;
        this.actor.set_child_above_sibling(back, front);

        if (!this.actor.mapped) {
            back.set({opacity: 255, scale_x: 1, scale_y: 1});
            front.opacity = 0;
            return;
        }
        // Plain crossfade: the new art fades in on top of the old one
        back.set({opacity: 0, scale_x: 1, scale_y: 1});
        back.ease({
            opacity: 255,
            duration: CROSSFADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        front.ease({
            opacity: 0,
            delay: CROSSFADE_MS / 2,
            duration: CROSSFADE_MS / 2,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    destroy() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this.actor = null;
    }
}
