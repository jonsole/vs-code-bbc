// What the screen says now, as rows of text, read from screen memory rather
// than from what was printed: right after a CLS, a scroll, or a program that
// writes the screen itself.
//
//   MODE 7      screen memory is the text: a byte per character, teletext
//   MODES 0-6   each character cell's pixels are matched against the font,
//               in either polarity, so inverse text reads too
//
// Where the screen is comes from the OS's VDU variables, so this reads screens
// the OS laid out; a game that programs the 6845 itself gets what the OS
// thinks is there. A cell that is not a character in the font -- a sprite,
// a user-defined character, graphics -- reads as "·", and an empty one as a
// space, so a picture reads as a picture rather than as letters.
//
// Kept free of jsbeeb: it takes a byte reader and the font, so it is tested
// from saved screen memory.

export const VduVars = {
    topLeft: 0x350, // address of the top-left character (moves with hardware scroll)
    rowBytes: 0x352, // bytes per character row
    screenStartHi: 0x34e, // high byte of where screen memory starts
    mode: 0x355,
};

// Columns, rows and bits per pixel for each mode.
const Modes = [
    { cols: 80, rows: 32, bpp: 1 },
    { cols: 40, rows: 32, bpp: 2 },
    { cols: 20, rows: 32, bpp: 4 },
    { cols: 80, rows: 25, bpp: 1 },
    { cols: 40, rows: 32, bpp: 1 },
    { cols: 20, rows: 32, bpp: 2 },
    { cols: 40, rows: 25, bpp: 1 },
    { cols: 40, rows: 25, bpp: 8 }, // teletext: a byte a character
];

const Unknown = "·";

/**
 * The font as matching wants it: an 8-byte cell pattern, as a string key, to
 * its character. `glyphs` is the MOS's character definitions for 32-126, 8
 * bytes each, as they sit at the start of the OS ROM.
 */
export function fontIndex(glyphs) {
    const index = new Map();
    for (let c = 32; c < 127; c++) {
        const bytes = glyphs.subarray((c - 32) * 8, (c - 32) * 8 + 8);
        const key = Array.from(bytes).join(",");
        if (!index.has(key)) index.set(key, String.fromCharCode(c));
    }
    return index;
}

/** One scanline's 8 pixels of a cell as a 1-bit pattern: a pixel is set if it is not colour 0. */
function scanline(read, cellAddr, line, bpp, wrap) {
    if (bpp === 1) return read(wrap(cellAddr + line));
    // Multi-byte cells: each byte is a column of 8 scanlines, 8/bpp pixels wide.
    const perByte = 8 / bpp;
    let bits = 0;
    for (let col = 0; col < bpp; col++) {
        const b = read(wrap(cellAddr + col * 8 + line));
        for (let px = 0; px < perByte; px++) {
            // A pixel's bits are spread across the byte, one in each group of perByte.
            let on = false;
            for (let k = 0; k < bpp; k++) {
                if (b & (0x80 >> (px + k * perByte))) on = true;
            }
            if (on) bits |= 0x80 >> (col * perByte + px);
        }
    }
    return bits;
}

const TeletextMap = { 0x23: "£", 0x5f: "#", 0x60: "_" };

function teletextRow(read, rowAddr, cols, wrap) {
    let graphics = false;
    let out = "";
    for (let x = 0; x < cols; x++) {
        const b = read(wrap(rowAddr + x)) & 0x7f;
        if (b < 0x20) {
            // Control codes take a cell and show as a space; 0x11-0x17 start
            // graphics, 0x01-0x07 go back to letters.
            if (b >= 0x11 && b <= 0x17) graphics = true;
            else if (b >= 0x01 && b <= 0x07) graphics = false;
            out += " ";
        } else if (graphics && !(b >= 0x40 && b <= 0x5f)) {
            // A block-graphics cell; capitals "blast through" as letters.
            out += b === 0x20 ? " " : Unknown;
        } else {
            out += TeletextMap[b] ?? String.fromCharCode(b);
        }
    }
    return out;
}

/**
 * @param {object} p
 * @param {(addr: number) => number} p.read   a byte of screen memory (shadow, if that is displayed)
 * @param {number} p.mode
 * @param {number} p.topLeft    address of the top-left character
 * @param {number} p.rowBytes   bytes per character row
 * @param {number} p.screenStart  where screen memory starts; addresses at &8000 wrap back to it
 * @param {Map<string,string>} p.font  from fontIndex()
 * @returns {string} rows, trailing spaces and blank rows trimmed
 */
export function readScreenText({ read, mode, topLeft, rowBytes, screenStart, font }) {
    const m = Modes[mode & 7];
    const size = 0x8000 - screenStart;
    const wrap = (a) => {
        a &= 0xffff;
        return a >= 0x8000 ? a - size : a;
    };
    const rows = [];
    for (let y = 0; y < m.rows; y++) {
        const rowAddr = topLeft + y * rowBytes;
        if (m.bpp === 8) {
            rows.push(teletextRow(read, rowAddr, m.cols, wrap));
            continue;
        }
        const cellBytes = 8 * m.bpp;
        let out = "";
        for (let x = 0; x < m.cols; x++) {
            const cell = rowAddr + x * cellBytes;
            const lines = [];
            for (let l = 0; l < 8; l++) lines.push(scanline(read, cell, l, m.bpp, wrap));
            if (lines.every((v) => v === 0) || lines.every((v) => v === 0xff)) {
                out += " ";
                continue;
            }
            const key = lines.join(",");
            const inverse = lines.map((v) => v ^ 0xff).join(",");
            out += font.get(key) ?? font.get(inverse) ?? Unknown;
        }
        rows.push(out);
    }
    const trimmed = rows.map((r) => r.trimEnd());
    while (trimmed.length && trimmed.at(-1) === "") trimmed.pop();
    return trimmed.join("\n");
}
