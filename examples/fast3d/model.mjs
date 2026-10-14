// The arithmetic of fast3d.6502, exactly as the 6502 does it: check.mjs
// compares every result the assembled routines leave with what these say.
// The ZX Spectrum's fast3d (zx-spectrum-emulator/examples/fast3d/model.py)
// is the same arithmetic; only the screen differs.

// The quarter squares: a*b = f(a+b) - f(a-b), f(n) = floor(n*n/4).
export const quarterSquare = (n) => Math.floor((n * n) / 4);

// The sines make_matrix sums: 2032 = 16 * 127, so that four of them, the
// most an entry adds up to, come to 127 * 64 at most.
export const SINE_SCALE = 2032;
export const sine = (a) => Math.floor(SINE_SCALE * Math.sin((2 * Math.PI * (a & 255)) / 256) + 0.5);
const s = sine;
const c = (a) => sine(a + 64);

/** The nine entries of Rz(z) Ry(y) Rx(x), each 4 * 2032 * the entry, from sines of sums of angles. */
export function matrixSums(x, y, z) {
    return [
        2 * (c(y - z) + c(y + z)),
        c(x - y - z) + c(x - y + z) - c(x + y - z) - c(x + y + z) - 2 * (s(z + x) + s(z - x)),
        s(x + y + z) + s(x + y - z) - s(x - y + z) - s(x - y - z) + 2 * (c(x - z) - c(x + z)),
        2 * (s(z + y) + s(z - y)),
        s(z + x - y) + s(z - x + y) - s(z + x + y) - s(z - x - y) + 2 * (c(x - z) + c(x + z)),
        c(x + y - z) - c(x + y + z) - c(x - y - z) + c(x - y + z) - 2 * (s(x + z) + s(x - z)),
        -4 * s(y),
        2 * (s(x + y) + s(x - y)),
        2 * (c(x - y) + c(x + y)),
    ];
}

/** The nine entries, signed bytes with 127 for 1.0: (sum + 32) >> 6. */
export const makeMatrix = (x, y, z) => matrixSums(x, y, z).map((q) => (q + 32) >> 6);

/** M v: 16-bit sums. */
export function rotate(m, v) {
    return [0, 1, 2].map((row) => m[3 * row] * v[0] + m[3 * row + 1] * v[1] + m[3 * row + 2] * v[2]);
}

/** S / Z, truncated toward zero; null if it does not fit a byte. */
export function divide(n, z) {
    const q = Math.floor(Math.abs(n) / z);
    if (q > 255) return null;
    return n < 0 ? -q : q;
}

/** The screen point a rotated vertex lands on (256 x 255, y down), or null if off it. */
export function project([sx, sy, sz], zoff, centreX = 128, centreY = 127, height = 255) {
    const z = (sz + zoff) >> 8;
    if (z < 1 || z > 255) return null;
    const qx = divide(sx, z);
    const qy = divide(sy, z);
    if (qx === null || qy === null) return null;
    const px = centreX + qx;
    const py = centreY - qy;
    if (px < 0 || px > 255 || py < 0 || py >= height) return null;
    return [px, py];
}

/** The pixels draw_line sets: Bresenham, drawn downwards (the ends swapped if
 * need be), stepping along the longer axis with the error starting at half of it. */
export function line(x0, y0, x1, y1) {
    if (y1 < y0) [x0, y0, x1, y1] = [x1, y1, x0, y0];
    const dx = Math.abs(x1 - x0);
    const dy = y1 - y0;
    const sx = x1 >= x0 ? 1 : -1;
    const pixels = [];
    let [x, y] = [x0, y0];
    if (dx >= dy) {
        let err = dx >> 1;
        for (let i = 0; i <= dx; i++) {
            pixels.push([x, y]);
            err -= dy;
            if (err < 0) {
                err += dx;
                y++;
            }
            x += sx;
        }
    } else {
        let err = dy >> 1;
        for (let i = 0; i <= dy; i++) {
            pixels.push([x, y]);
            err -= dx;
            if (err < 0) {
                err += dy;
                x += sx;
            }
            y++;
        }
    }
    return pixels;
}

/** The byte of a MODE 4 screen at `base` holding window pixel (x, y): the
 * window is the screen's middle 256 columns, 32 pixels in. */
export const screenAddress = (x, y, base = 0x3000) => base + (y >> 3) * 320 + (y & 7) + ((x + 32) >> 3) * 8;

/** A MODE 4 screen (10K) with these lines on it. */
export function render(lines, base = 0x3000) {
    const screen = new Uint8Array(10240);
    for (const l of lines) for (const [x, y] of line(...l)) screen[screenAddress(x, y, base) - base] |= 0x80 >> (x & 7);
    return screen;
}
