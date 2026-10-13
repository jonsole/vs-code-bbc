// Debug information for the program being debugged: symbols (name <-> address)
// and, where the assembler gives us enough, a map between addresses and source
// lines so breakpoints can be set in, and stops shown at, the source.
//
// What is understood:
//   - BeebAsm's `-d`/`-dd -labels <file>` symbol dump ("Swift" format)
//   - BeebAsm's `-v` listing, matched back to the source (see below), and the
//     source's own `name = &70` constants, which BeebAsm's dump leaves out
//     (written in hex they are taken to be addresses, in decimal plain numbers)
//   - ca65/ld65's `--dbgfile` (symbols and lines, exactly)
//   - VICE label files (`al C:1900 .start`), as ld65 -Ln, 64tass and others write
//   - plain `name = &1900` / `name = $1900` / `name: 0x1900` / `name 1900` lines
//
// BeebAsm records no line numbers anywhere, so its listing is lined up with the
// source by walking both in order: each instruction in the source is paired
// with the next instruction in the listing with the same mnemonic and
// addressing-mode shape, and every label is a point where the two are put back
// in step. That is exact for straight-line code and INCLUDEd files; inside a
// MACRO, or a FOR loop's second time round, an address maps to the line that
// produced its first copy, or to nothing.

import fs from "node:fs";
import path from "node:path";
import { parseNumber } from "./expr.mjs";

const Mnemonics = new Set(
    (
        "ADC AND ASL BCC BCS BEQ BIT BMI BNE BPL BRK BVC BVS CLC CLD CLI CLV CMP CPX CPY DEC DEX DEY " +
        "EOR INC INX INY JMP JSR LDA LDX LDY LSR NOP ORA PHA PHP PLA PLP ROL ROR RTI RTS SBC SEC SED " +
        "SEI STA STX STY TAX TAY TSX TXA TXS TYA BRA PHX PHY PLX PLY STZ TRB TSB INA DEA"
    ).split(" "),
);

export function normalisePath(p) {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
}

export class DebugInfo {
    constructor() {
        this.symbols = new Map(); // name -> address
        this.byAddress = new Map(); // address -> name
        this.lines = new Map(); // address -> { file, line }   (line is 1-based)
        this.fileLines = new Map(); // normalised file -> Map(line -> address)
        this.sources = []; // files loaded from, for server_info
    }

    get empty() {
        return this.symbols.size === 0 && this.lines.size === 0;
    }

    /** `address: false` for a constant that is only a number: it can be used in expressions but names no address. */
    addSymbol(name, address, { address: isAddress = true } = {}) {
        name = name.replace(/^\./, "");
        if (!name || address === undefined || Number.isNaN(address)) return;
        address &= 0xffff;
        this.symbols.set(name, address);
        if (!isAddress) return;
        // Prefer the shortest name at an address: a label over a long local alias.
        const existing = this.byAddress.get(address);
        if (existing === undefined || name.length < existing.length) this.byAddress.set(address, name);
    }

    addLine(address, file, line) {
        address &= 0xffff;
        if (!this.lines.has(address)) this.lines.set(address, { file, line });
        const key = normalisePath(file);
        let m = this.fileLines.get(key);
        if (!m) this.fileLines.set(key, (m = new Map()));
        if (!m.has(line) || m.get(line) > address) m.set(line, address);
    }

    lookup(name) {
        if (this.symbols.has(name)) return this.symbols.get(name);
        const lower = name.toLowerCase();
        for (const [k, v] of this.symbols) if (k.toLowerCase() === lower) return v;
        return undefined;
    }

    /** Nearest symbol at or below the address, within `range` bytes: { name, offset } */
    nearest(address, range = 256) {
        let best;
        for (const [a, name] of this.byAddress) {
            if (a <= address && address - a <= range && (!best || a > best.address)) best = { address: a, name };
        }
        return best ? { name: best.name, offset: address - best.address } : undefined;
    }

    lineFor(address) {
        return this.lines.get(address & 0xffff);
    }

    /**
     * Where a breakpoint on a source line lands: that line's address, or the
     * next line below it with code within `slack` lines.
     */
    addressForLine(file, line, slack = 20) {
        const m = this.fileLines.get(normalisePath(file));
        if (!m) return undefined;
        for (let l = line; l <= line + slack; l++) {
            if (m.has(l)) return { line: l, address: m.get(l) };
        }
        return undefined;
    }

    hasFile(file) {
        return this.fileLines.has(normalisePath(file));
    }

    /** Load whatever kind of file this is. `source` is the main source file, for a BeebAsm listing. */
    loadFile(file, { source } = {}) {
        const text = fs.readFileSync(file, "utf8");
        const kind = detectKind(file, text);
        if (kind === "ca65") loadCa65(this, text, path.dirname(file));
        else if (kind === "beebasm-listing") {
            if (!source) throw new Error(`${file} is a BeebAsm listing: give the source file it was assembled from too`);
            loadBeebAsmListing(this, text, source);
        } else loadSymbolText(this, text);
        this.sources.push({ file, kind });
        return kind;
    }
}

export function detectKind(file, text) {
    if (/\.dbg$/i.test(file) || /^version\s+major=/m.test(text)) return "ca65";
    if (/^\s+[0-9A-F]{4}\s{3}[0-9A-F]{2}( |$)/m.test(text) && !/^\[\{/.test(text.trim())) return "beebasm-listing";
    return "symbols";
}

export function loadSymbolText(info, text) {
    // BeebAsm's -d/-dd: [{'.start':8192L,'loop@1':8194L}]
    if (/^\s*\[\{/.test(text)) {
        for (const m of text.matchAll(/'([^']+)':\s*(-?\d+)L?/g)) {
            // Locals carry an @scope suffix; keep the plain name if it is free.
            const name = m[1].replace(/^\./, "");
            info.addSymbol(name, Number(m[2]));
        }
        return;
    }
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/[;#].*$/, "").trim();
        if (!line) continue;
        let m;
        if ((m = /^al\s+(?:C:)?([0-9a-f]+)\s+\.?(\S+)/i.exec(line))) {
            info.addSymbol(m[2], parseInt(m[1], 16));
        } else if ((m = /^\.?([A-Za-z_][\w.@]*)\s*([=:]?)\s*(&[0-9a-f]+|\$[0-9a-f]+|0x[0-9a-f]+|[0-9a-f]+)$/i.exec(line))) {
            // A bare number after = or : is decimal, as an assembler would read it;
            // after only a space it is a symbol dump's hex address.
            const v = /^[0-9a-f]+$/i.test(m[3]) && !m[2] ? parseInt(m[3], 16) : parseNumber(m[3]);
            if (v !== undefined) info.addSymbol(m[1], v);
        }
    }
}

// ---------------------------------------------------------------------------
// ca65 / ld65 --dbgfile

function parseDbgFields(rest) {
    const out = {};
    for (const m of rest.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|[^,]*)/g)) {
        out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
    }
    return out;
}

function loadCa65(info, text, baseDir) {
    const files = new Map();
    const segs = new Map();
    const spans = new Map();
    const lines = [];
    const syms = [];
    for (const raw of text.split(/\r?\n/)) {
        const m = /^(\w+)\s+(.*)$/.exec(raw);
        if (!m) continue;
        const f = parseDbgFields(m[2]);
        switch (m[1]) {
            case "file":
                files.set(f.id, path.resolve(baseDir, f.name));
                break;
            case "seg":
                segs.set(f.id, Number(f.start));
                break;
            case "span":
                spans.set(f.id, { seg: f.seg, start: Number(f.start), size: Number(f.size) });
                break;
            case "line":
                lines.push(f);
                break;
            case "sym":
                syms.push(f);
                break;
        }
    }
    for (const s of syms) {
        if (s.val === undefined || s.type === "imp") continue;
        // Labels only: an equate's value is a number, not necessarily an address.
        if (s.type === "lab" || s.seg !== undefined) info.addSymbol(s.name, Number(s.val));
    }
    for (const l of lines) {
        if (l.span === undefined || l.type === "1") continue; // type 1: inside a macro expansion
        const file = files.get(l.file);
        if (!file) continue;
        for (const id of l.span.split("+")) {
            const span = spans.get(id);
            if (!span || !segs.has(span.seg)) continue;
            info.addLine(segs.get(span.seg) + span.start, file, Number(l.line));
        }
    }
}

// ---------------------------------------------------------------------------
// BeebAsm -v listing, lined up with the source

function parseListing(text) {
    const entries = [];
    for (const raw of text.split(/\r?\n/)) {
        let m;
        if ((m = /^\.(\S+)\s*$/.exec(raw))) {
            entries.push({ kind: "label", name: m[1] });
        } else if ((m = /^\s+([0-9A-F]{4})\s{3}((?:[0-9A-F]{2} ?)+(?:\.\.\.)?)\s*(.*)$/.exec(raw))) {
            const text = m[3].trim();
            const mnemonic = text.slice(0, 3).toUpperCase();
            if (text && Mnemonics.has(mnemonic)) {
                entries.push({ kind: "insn", address: parseInt(m[1], 16), mnemonic, shape: operandShape(text.slice(3)) });
            }
        }
    }
    return entries;
}

/** What survives assembly of an operand: immediate, indirect, indexing; not the value. */
function operandShape(operand) {
    const o = operand.trim().toUpperCase().replace(/\s+/g, "");
    if (!o || o === "A") return "";
    let shape = "";
    if (o.startsWith("#")) shape += "#";
    if (o.startsWith("(")) shape += "(";
    const idx = /,([XY])\)?$|\),([XY])$/.exec(o);
    if (idx) shape += idx[1] ?? idx[2];
    return shape;
}

/** Split a source line into statements: ':' separates, ';' and '\' start comments, strings are opaque. */
function statements(line) {
    const out = [];
    let cur = "";
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            cur += c;
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"') {
            quote = c;
            cur += c;
        } else if (c === ";" || c === "\\") break;
        else if (c === ":") {
            out.push(cur);
            cur = "";
        } else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim()).filter(Boolean);
}

function sourceItems(file, items, depth = 0, seen = new Set()) {
    if (depth > 16 || seen.has(normalisePath(file))) return;
    seen.add(normalisePath(file));
    let text;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return;
    }
    let inMacro = false;
    text.split(/\r?\n/).forEach((raw, index) => {
        for (let st of statements(raw)) {
            let m;
            if ((m = /^\.([A-Za-z_][\w]*)\s*(.*)$/.exec(st))) {
                if (!inMacro) items.push({ kind: "label", name: m[1], file, line: index + 1 });
                st = m[2];
                if (!st) continue;
            }
            // BeebAsm's symbol dump leaves out `name = value`; take the simple ones from the source.
            if (!inMacro && (m = /^([A-Za-z_]\w*)\s*=\s*(&[0-9a-f]+|\$[0-9a-f]+|0x[0-9a-f]+|\d+)\s*$/i.exec(st))) {
                items.push({ kind: "equate", name: m[1], value: parseNumber(m[2]), hex: !/^\d/.test(m[2]) });
                continue;
            }
            const word = (/^[A-Za-z]+/.exec(st)?.[0] ?? "").toUpperCase();
            if (word === "MACRO") inMacro = true;
            else if (word === "ENDMACRO") inMacro = false;
            else if (inMacro) continue;
            else if (word === "INCLUDE" && (m = /"([^"]+)"/.exec(st))) {
                const candidates = [path.resolve(path.dirname(file), m[1]), path.resolve(m[1])];
                const found = candidates.find((c) => fs.existsSync(c));
                if (found) sourceItems(found, items, depth + 1, seen);
            } else if (word.length === 3 && Mnemonics.has(word) && !/^[A-Za-z]{3}\w/.test(st)) {
                items.push({ kind: "insn", mnemonic: word, shape: operandShape(st.slice(3)), file, line: index + 1 });
            }
        }
    });
}

export function loadBeebAsmListing(info, listingText, sourceFile) {
    const listing = parseListing(listingText);
    const items = [];
    sourceItems(path.resolve(sourceFile), items);

    // Where each label sits in the listing, in order, so the walk can find the next one.
    const labelAt = new Map();
    listing.forEach((e, i) => {
        if (e.kind !== "label") return;
        if (!labelAt.has(e.name)) labelAt.set(e.name, []);
        labelAt.get(e.name).push(i);
    });

    const MaxScan = 48;
    let p = 0;
    let matched = 0;
    for (const item of items) {
        if (item.kind === "equate") {
            if (info.lookup(item.name) === undefined) info.addSymbol(item.name, item.value, { address: item.hex });
            continue;
        }
        if (item.kind === "label") {
            const positions = labelAt.get(item.name);
            const next = positions?.find((i) => i >= p);
            if (next !== undefined) p = next + 1;
            continue;
        }
        for (let i = p; i < listing.length && i < p + MaxScan; i++) {
            const e = listing[i];
            if (e.kind === "label") break;
            if (e.mnemonic === item.mnemonic && e.shape === item.shape) {
                info.addLine(e.address, item.file, item.line);
                matched++;
                p = i + 1;
                break;
            }
        }
    }
    // The listing names every label it passed, so it is a symbol source too.
    return matched;
}
