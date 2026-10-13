// Where execution time goes: every instruction's address, how often it ran
// and the cycles it took (the time from its start to the next instruction's,
// so an interrupt's entry is charged to the instruction it followed), folded
// into source lines, routines, a call tree and periods (frames, or turns of a
// loop).
//
// Calls are followed by the stack pointer rather than by matching RTS to JSR:
// a frame is entered by a JSR, a BRK or an interrupt, and left when the stack
// pointer rises above where it was on entry, so code that drops a return
// address or jumps out of a routine does not leave the tree lopsided.
//
// Idle time is the time in routines named as waiting -- the loop a game paces
// itself with, or the OS waiting for a key -- and is left out of busy time.

import { hex, isBanked } from "./engine.mjs";

const Opcode = { BRK: 0x00, JSR: 0x20 };
const Slots = 0x10000 + 16 * 0x4000; // every address, and &8000-&BFFF once per sideways bank
const Outside = "(outside any call)";

export class Profiler {
    /** @param {import("./engine.mjs").Engine} engine */
    constructor(engine) {
        this.engine = engine;
        this.idle = []; // routine names
        this.period = "frame"; // or a routine name
        this.active = false;
        this._idleRanges = [];
    }

    _clear() {
        this.hits = new Uint32Array(Slots);
        this.cycles = new Float64Array(Slots);
        this.idleCycles = new Float64Array(Slots);
        this.callCycles = new Float64Array(Slots); // at a JSR: the time its calls took
        this.callIdle = new Float64Array(Slots);
        this.instructions = 0;
        this.interrupts = 0;
        this.total = 0;
        this.totalIdle = 0;
        this.tree = newNode(Outside);
        this.frames = [{ node: this.tree, s: 0x1ff, site: -1, start: 0, idle: false, idleAtStart: 0 }];
        this.periods = [];
        this._period = null;
        this._prev = null; // { slot, opcode, cycles, idle }
        this._firstFrame = this.engine.frameCount;
        this._routineCache = new Map();
    }

    /** Count from zero from the next instruction; `idle` and `period` carry over unless given. */
    start({ idle, period } = {}) {
        if (idle !== undefined) this.idle = idle;
        if (period !== undefined) this.period = period;
        this._clear();
        this._idleRanges = this._resolve(this.idle);
        this._periodAddress = this.period === "frame" ? undefined : this._resolve([this.period])[0]?.start;
        this.active = true;
        this._lastPaint = this.engine.paintCount;
        this._newPeriod();
    }

    stop() {
        if (this.active) this._closePeriod();
        this.active = false;
        this._prev = null;
    }

    /** Routine names to [{ name, start, end }]; the ones that match nothing go to `unresolved`. */
    _resolve(names) {
        const out = [];
        this.unresolved = [];
        const info = this.engine.debugInfo;
        for (const name of names) {
            const address = info.lookup(name);
            if (address === undefined) {
                this.unresolved.push(name);
                continue;
            }
            const end = info.nextSymbolAfter?.(address) ?? address + 0x100;
            out.push({ name, start: address, end });
        }
        return out;
    }

    _slot(pc) {
        return isBanked(pc) ? 0x10000 + (this.engine.cpu.romsel & 0x0f) * 0x4000 + (pc - 0x8000) : pc;
    }

    _inIdle(pc) {
        for (const r of this._idleRanges) if (pc >= r.start && pc < r.end) return true;
        return false;
    }

    /** At the start of every instruction. */
    instruction(pc, opcode) {
        const e = this.engine;
        const cpu = e.cpu;
        const now = e.elapsedCycles;
        const prev = this._prev;
        if (prev) {
            const spent = now - prev.cycles;
            this.cycles[prev.slot] += spent;
            this.total += spent;
            this.frames.at(-1).node.self += spent;
            if (prev.idle) {
                this.idleCycles[prev.slot] += spent;
                this.totalIdle += spent;
            }
            if (this._period) {
                this._period.cycles += spent;
                if (prev.idle) this._period.idle += spent;
                const r = this.routineOf(prev.pc, prev.bank);
                this._period.routines.set(r, (this._period.routines.get(r) ?? 0) + spent);
            }
        }
        // Frames left: the stack is back above where they were entered.
        const frames = this.frames;
        while (frames.length > 1 && cpu.s > frames.at(-1).s) {
            const f = frames.pop();
            if (f.site >= 0) {
                this.callCycles[f.site] += now - f.start;
                this.callIdle[f.site] += this.totalIdle - f.idleAtStart;
            }
        }
        // Frames entered: by the JSR or BRK just run, or an interrupt just taken.
        let entered = null;
        if (prev && (prev.opcode === Opcode.JSR || prev.opcode === Opcode.BRK)) entered = { name: e.symbolFor(pc) ?? hex(pc), site: prev.slot };
        else if (prev && e._irqEntry(cpu)) {
            entered = { name: "(interrupt)", site: -1 };
            this.interrupts++;
        }
        if (entered) {
            const parent = frames.at(-1);
            let node = parent.node.children.get(entered.name);
            if (!node) parent.node.children.set(entered.name, (node = newNode(entered.name)));
            node.calls++;
            frames.push({ node, s: cpu.s, site: entered.site, start: now, idle: parent.idle || this._inIdle(pc), idleAtStart: this.totalIdle });
        }
        // Periods: a frame painted, or arrival at the period's routine.
        if (this._periodAddress !== undefined) {
            if (pc === this._periodAddress) this._newPeriod();
        } else if (e.paintCount !== this._lastPaint) {
            this._lastPaint = e.paintCount;
            this._newPeriod();
        }
        const slot = this._slot(pc);
        this.hits[slot]++;
        this.instructions++;
        this._prev = { slot, pc, bank: e.bankAt(pc), opcode, cycles: now, idle: frames.at(-1).idle || this._inIdle(pc) };
    }

    _newPeriod() {
        this._closePeriod();
        this._period = { start_frame: this.engine.frameCount, cycles: 0, idle: 0, routines: new Map() };
    }

    _closePeriod() {
        const p = this._period;
        if (!p || p.cycles === 0) return;
        this.periods.push(p);
        // Keep what the report needs: the ten busiest in full, and the rest as numbers.
        if (this.periods.length > 5000) this.periods.shift();
        this._period = null;
    }

    /** The routine an address is in: its nearest symbol at or before it, or its 256-byte page. */
    routineOf(pc, bank) {
        const key = bank === undefined ? pc : `${bank}:${pc}`;
        let r = this._routineCache.get(key);
        if (r === undefined) {
            const near = this.engine.debugInfo.nearest(pc, 0x1000, bank) ?? null;
            const os = this.engine._osSymbol(pc);
            if (near && !near.name.startsWith(".")) r = near.name;
            else if (os && os.offset === 0) r = os.name;
            else r = `${bank !== undefined ? `${bank}:` : ""}${hex(pc & 0xff00)}-${hex((pc & 0xff00) | 0xff)}`;
            this._routineCache.set(key, r);
        }
        return r;
    }

    report({ lines = 20, routines = 20, treeMinPercent = 2 } = {}) {
        const e = this.engine;
        if (!this.hits) return { active: false, note: 'Nothing measured yet: profile {action: "start"}, then run' };
        const frameCycles = e.model.cyclesPerSecond / 50;
        const framesSeen = Math.max(1, e.frameCount - this._firstFrame);
        const busy = this.total - this.totalIdle;
        const out = {
            active: this.active,
            idle: this.idle,
            period: this.period,
            totals: {
                frames: e.frameCount - this._firstFrame,
                instructions: this.instructions,
                interrupts: this.interrupts,
                cycles: this.total,
                idle_cycles: this.totalIdle,
                busy_cycles: busy,
                cycles_per_frame: Math.round(this.total / framesSeen),
                busy_cycles_per_frame: Math.round(busy / framesSeen),
                frame_cycles: frameCycles,
            },
        };
        if (this.unresolved?.length) out.unresolved = this.unresolved;

        // Per address, then per source line where there is one.
        const byLine = new Map();
        const byRoutine = new Map();
        for (let slot = 0; slot < Slots; slot++) {
            if (!this.hits[slot]) continue;
            const [pc, bank] = slot < 0x10000 ? [slot, undefined] : [0x8000 + ((slot - 0x10000) & 0x3fff), (slot - 0x10000) >> 14];
            const where = e.debugInfo.lineFor(pc, bank);
            const key = where ? `${where.file}:${where.line}` : `@${slot}`;
            let l = byLine.get(key);
            if (!l) {
                l = where ? { path: where.file, line: where.line } : {};
                l.symbol = e.describeAddress(pc, bank);
                l.hits = 0;
                l.cycles = 0;
                l.idle_cycles = 0;
                byLine.set(key, l);
            }
            l.hits += this.hits[slot];
            l.cycles += this.cycles[slot];
            l.idle_cycles += this.idleCycles[slot];
            if (this.callCycles[slot]) {
                l.calls_cycles = (l.calls_cycles ?? 0) + this.callCycles[slot];
                l.calls_idle_cycles = (l.calls_idle_cycles ?? 0) + this.callIdle[slot];
            }
            const name = this.routineOf(pc, bank);
            let r = byRoutine.get(name);
            if (!r) byRoutine.set(name, (r = { routine: name, hits: 0, cycles: 0, idle_cycles: 0 }));
            r.hits += this.hits[slot];
            r.cycles += this.cycles[slot];
            r.idle_cycles += this.idleCycles[slot];
        }
        const top = (list, n) => {
            const sorted = [...list].sort((a, b) => b.cycles - a.cycles);
            return n > 0 ? sorted.slice(0, n) : sorted;
        };
        out.lines = top(byLine.values(), lines).map((l) => ({ ...l, cycles: Math.round(l.cycles), idle_cycles: Math.round(l.idle_cycles) }));
        out.routines = top(byRoutine.values(), routines);

        // The call tree: each node's time is its own and its children's.
        const total = (node) => {
            let t = node.self;
            for (const c of node.children.values()) t += total(c);
            return t;
        };
        const cut = (this.total * treeMinPercent) / 100;
        const shape = (node) => {
            const children = [...node.children.values()].map((c) => ({ node: c, t: total(c) })).sort((a, b) => b.t - a.t);
            const kept = children.filter((c) => c.t >= cut);
            const other = children.filter((c) => c.t < cut).reduce((n, c) => n + c.t, 0);
            const out = { name: node.name, calls: node.calls, cycles: Math.round(total(node)), self_cycles: Math.round(node.self) };
            if (kept.length) out.children = kept.map((c) => shape(c.node));
            if (other) out.other_calls_cycles = Math.round(other);
            return out;
        };
        out.call_tree = shape(this.tree);

        // Periods.
        const periods = this._period?.cycles ? [...this.periods, this._period] : this.periods;
        if (periods.length) {
            const busyOf = (p) => p.cycles - p.idle;
            const worst = [...periods].sort((a, b) => busyOf(b) - busyOf(a)).slice(0, 10);
            out.periods = {
                count: periods.length,
                busy_cycles_average: Math.round(periods.reduce((n, p) => n + busyOf(p), 0) / periods.length),
                busiest_cycles: Math.round(busyOf(worst[0])),
                without_idle: periods.filter((p) => p.idle === 0).length,
                worst: worst.map((p) => ({
                    start_frame: p.start_frame,
                    cycles: Math.round(p.cycles),
                    idle_cycles: Math.round(p.idle),
                    busy_cycles: Math.round(busyOf(p)),
                    routines: [...p.routines.entries()]
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 5)
                        .map(([routine, cycles]) => ({ routine, cycles: Math.round(cycles) })),
                })),
            };
        }
        return out;
    }
}

function newNode(name) {
    return { name, calls: 0, self: 0, children: new Map() };
}
