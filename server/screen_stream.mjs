// The live screen, for VS Code's screen panel: every painted frame (up to a
// rate the client asks for), palette-indexed and deflated, on a long-lived
// HTTP response.
//
// Wire format, repeated: a 4-byte big-endian length, then that many bytes:
//   u16 width, u16 height, u32 frame number, u16 palette size N,
//   N*3 bytes of RGB, then the deflated width*height palette indices.
// A BBC frame has at most a handful of colours (teletext's smoothing adds a
// few more), so this is a few KB a frame. A frame with more than 256 colours
// (NuLA, filters) falls back to N = 0 and deflated RGB.

import zlib from "node:zlib";

export function encodeFrame({ width, height, rgba }, frameNumber) {
    const indices = Buffer.alloc(width * height);
    const palette = new Map();
    const colours = [];
    let overflow = false;
    const px = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
    for (let i = 0; i < px.length; i++) {
        const c = px[i] & 0xffffff;
        let idx = palette.get(c);
        if (idx === undefined) {
            if (colours.length === 256) {
                overflow = true;
                break;
            }
            idx = colours.length;
            palette.set(c, idx);
            colours.push(c);
        }
        indices[i] = idx;
    }
    let pal;
    let body;
    if (overflow) {
        pal = Buffer.alloc(0);
        const rgb = Buffer.alloc(width * height * 3);
        for (let i = 0, o = 0; i < px.length; i++) {
            rgb[o++] = rgba[i * 4];
            rgb[o++] = rgba[i * 4 + 1];
            rgb[o++] = rgba[i * 4 + 2];
        }
        body = zlib.deflateRawSync(rgb, { level: 1 });
    } else {
        pal = Buffer.alloc(colours.length * 3);
        colours.forEach((c, i) => {
            pal[i * 3] = c & 0xff; // the framebuffer is little-endian ABGR: R is the low byte
            pal[i * 3 + 1] = (c >> 8) & 0xff;
            pal[i * 3 + 2] = (c >> 16) & 0xff;
        });
        body = zlib.deflateRawSync(indices, { level: 1 });
    }
    const header = Buffer.alloc(14);
    header.writeUInt32BE(10 + pal.length + body.length, 0);
    header.writeUInt16BE(width, 4);
    header.writeUInt16BE(height, 6);
    header.writeUInt32BE(frameNumber >>> 0, 8);
    header.writeUInt16BE(overflow ? 0 : colours.length, 12);
    return Buffer.concat([header, pal, body]);
}

/** Decode one message (without its length prefix) back to RGBA: for tests and for clients. */
export function decodeFrame(buf) {
    const width = buf.readUInt16BE(0);
    const height = buf.readUInt16BE(2);
    const frame = buf.readUInt32BE(4);
    const n = buf.readUInt16BE(8);
    const rgba = new Uint8Array(width * height * 4);
    if (n === 0) {
        const rgb = zlib.inflateRawSync(buf.subarray(10));
        for (let i = 0; i < width * height; i++) {
            rgba.set([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 255], i * 4);
        }
    } else {
        const pal = buf.subarray(10, 10 + n * 3);
        const idx = zlib.inflateRawSync(buf.subarray(10 + n * 3));
        for (let i = 0; i < width * height; i++) {
            const p = idx[i] * 3;
            rgba[i * 4] = pal[p];
            rgba[i * 4 + 1] = pal[p + 1];
            rgba[i * 4 + 2] = pal[p + 2];
            rgba[i * 4 + 3] = 255;
        }
    }
    return { width, height, frame, rgba };
}

/**
 * Serve the stream on an HTTP response. `fps` caps the rate; a client that
 * has not drained the last frame is skipped rather than queued for.
 */
export function serveStream(engine, req, res, { fps = 50 } = {}) {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.socket?.setNoDelay(true);
    const minGap = 1000 / Math.max(1, Math.min(50, fps));
    let last = 0;
    let lastFrame = -1;
    const send = (force = false) => {
        const now = performance.now();
        if (!force && (now - last < minGap || res.writableNeedDrain)) return;
        const n = engine.paintCount;
        if (!force && n === lastFrame) return;
        last = now;
        lastFrame = n;
        res.write(encodeFrame(engine.frame(), n));
    };
    const off = engine.onFrame(() => send());
    // A stopped machine paints nothing, but a client that just connected, or
    // memory written while stopped, still deserves a picture.
    const onStop = () => send(true);
    engine.on("stopped", onStop);
    engine.on("reset", onStop);
    send(true);
    const close = () => {
        off();
        engine.off("stopped", onStop);
        engine.off("reset", onStop);
    };
    req.on("close", close);
    res.on("error", close);
}
