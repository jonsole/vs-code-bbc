// An execution trace: a file with a row for every instruction the CPU runs,
// in order -- the cycle it started on, where it was (with the sideways bank),
// its bytes and disassembly, the registers before it ran, and every memory
// access it made, reads and writes, with their values.
//
// jsbeeb emulates the 6502 an instruction at a time, not bus cycle by bus
// cycle, so this is the trace there is: what each instruction did, rather than
// when within it each access reached the bus.
//
// A trace opens now or waits for execution to reach an address, and closes
// when asked, on reaching an address, or at its row limit, so a forgotten one
// cannot fill the disk.

import fs from "node:fs";
import path from "node:path";
import { hex } from "./engine.mjs";

const FlushBytes = 64 * 1024;

export class Trace {
    /**
     * @param {import("./engine.mjs").Engine} engine
     * @param {{ path: string, limit?: number, startPc?: number, stopPc?: number, watch?: number, symbols?: boolean }} opts
     */
    constructor(engine, { path: file, limit = 100000, startPc, stopPc, watch, symbols = true }) {
        this.engine = engine;
        this.path = path.resolve(file);
        this.limit = limit;
        this.startPc = startPc;
        this.stopPc = stopPc;
        this.watch = watch;
        this.symbols = symbols;
        this.rows = 0;
        this.active = true;
        this.waiting = startPc !== undefined;
        this.endedBy = null;
        this._fd = fs.openSync(this.path, "w");
        this._buffer = [];
        this._bufferBytes = 0;
        this._row = null; // the instruction being traced: its accesses are still to come
        this._write(this._header());
    }

    _header() {
        const cols = ["cycles", "pc", "bytes", "instruction", "A", "X", "Y", "S", "flags"];
        if (this.watch !== undefined) cols.push(`?${hex(this.watch)}`);
        cols.push("accesses");
        return `# BBC Micro execution trace: ${this.engine.model.name}\n# ${cols.join("\t")}\n`;
    }

    /** Before each instruction. Returns true if the trace has just closed itself. */
    instruction(pc) {
        if (!this.active) return false;
        if (this.waiting) {
            if (pc !== this.startPc) return false;
            this.waiting = false;
        }
        this._finishRow();
        if (this.stopPc !== undefined && pc === this.stopPc) {
            this.close("reached stop pc");
            return true;
        }
        if (this.limit > 0 && this.rows >= this.limit) {
            this.close("row limit");
            return true;
        }
        const e = this.engine;
        const cpu = e.cpu;
        const d = e.disassemble(pc);
        const where = this.symbols ? e.describeAddress(pc) : (e.bankAt(pc) !== undefined ? `${e.bankAt(pc)}:` : "") + hex(pc);
        const cols = [
            e.elapsedCycles,
            where,
            d.bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" "),
            d.text,
            hex(cpu.a, 2),
            hex(cpu.x, 2),
            hex(cpu.y, 2),
            hex(cpu.s, 2),
            e.flagsString(cpu.p.asByte()),
        ];
        if (this.watch !== undefined) cols.push(hex(e.peek(this.watch), 2));
        this._row = { cols, accesses: [], pc, length: d.bytes.length };
        this.rows++;
        return false;
    }

    /** A memory access by the instruction being traced; the fetches of its own bytes are left out. */
    access(kind, addr, val) {
        const row = this._row;
        if (!row || !this.active || this.waiting) return;
        if (kind === "R" && addr === this.engine.cpu.pc) return; // the instruction stream
        if (row.accesses.length < 16) row.accesses.push(`${kind} ${hex(addr)}=${hex(val, 2)}`);
    }

    _finishRow() {
        const row = this._row;
        if (!row) return;
        this._row = null;
        row.cols.push(row.accesses.join(" "));
        this._write(row.cols.join("\t") + "\n");
    }

    _write(text) {
        this._buffer.push(text);
        this._bufferBytes += text.length;
        if (this._bufferBytes >= FlushBytes) this.flush();
    }

    flush() {
        if (!this._buffer.length || this._fd === null) return;
        fs.writeSync(this._fd, this._buffer.join(""));
        this._buffer = [];
        this._bufferBytes = 0;
    }

    close(why = "stopped") {
        if (!this.active) return;
        this._finishRow();
        this.active = false;
        this.endedBy = why;
        this.flush();
        fs.closeSync(this._fd);
        this._fd = null;
    }

    status() {
        const out = { active: this.active, waiting: this.waiting, path: this.path, rows: this.rows, limit: this.limit };
        if (this.watch !== undefined) out.watch = hex(this.watch);
        if (this.startPc !== undefined) out.start_pc = this.engine.describeAddress(this.startPc);
        if (this.stopPc !== undefined) out.stop_pc = this.engine.describeAddress(this.stopPc);
        if (this.endedBy) out.ended_by = this.endedBy;
        return out;
    }
}
