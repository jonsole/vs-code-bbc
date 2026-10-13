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
//
// Two reports: report(), MCP's, the costliest lines and routines and a call
// tree cut to what matters; and editorReport(), the editor's heat map, in
// the shape the ZX Spectrum extension's profile view reads -- every source
// line, the routines with where they start, the whole call tree flat, and
// the worst periods each in full, so one can be shown as the whole is.

import { hex, isBanked } from "./engine.mjs";

const Opcode = { BRK: 0x00, JSR: 0x20 };
const Slots = 0x10000 + 16 * 0x4000; // every address, and &8000-&BFFF once per sideways bank
const Outside = "(outside any call)";
// The busiest periods kept in full, with their lines and call nodes.
const WorstKept = 10;
// Periods kept as numbers, for the averages and the strip.
const PeriodsKept = 5000;
// The most values the editor's strip of busy time per period is sent.
const StripMax = 1200;

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
        this.nodes = []; // every call node, by id: a parent always before its children
        this.tree = this._newNode(Outside, null);
        this.frames = [{ node: this.tree, s: 0x1ff, site: -1, start: 0, idle: false, idleAtStart: 0 }];
        this.periods = []; // { index, start_frame, cycles, idle }, the most recent PeriodsKept
        this.worst = []; // the busiest periods so far, in full
        this._periodCount = 0;
        this._period = null;
        this._prev = null; // { slot, opcode, cycles, idle }
        this._firstFrame = this.engine.frameCount;
        this._routineCache = new Map();
    }

    _newNode(name, parent, { addr, bank, interrupt = false } = {}) {
        const node = { id: this.nodes.length, parent: parent ? parent.id : null, name, addr, bank, interrupt, calls: 0, self: 0, idle: 0, children: new Map() };
        this.nodes.push(node);
        return node;
    }

    /** Count from zero from the next instruction; `idle` and `period` carry over unless given. */
    start({ idle, period } = {}) {
        this.configure({ idle, period });
        this._clear();
        this.active = true;
        this._lastPaint = this.engine.paintCount;
        this._newPeriod();
    }

    /** New idle routines or period, from now on: a profile already counting carries on under them. */
    configure({ idle, period } = {}) {
        if (idle !== undefined) this.idle = idle;
        if (period !== undefined) this.period = period;
        this._idleRanges = this._resolve(this.idle);
        const unresolved = this.unresolved;
        this._periodAddress = undefined;
        if (this.period !== "frame") {
            this._periodAddress = this._resolve([this.period])[0]?.start;
            unresolved.push(...this.unresolved);
        }
        this.unresolved = unresolved;
    }

    stop() {
        if (this.active) this._closePeriod();
        this.active = false;
        this._prev = null;
    }

    /** Routine names (or addresses) to [{ name, start, end }]; the ones that match nothing go to `unresolved`. */
    _resolve(names) {
        const out = [];
        this.unresolved = [];
        const info = this.engine.debugInfo;
        for (const name of names) {
            let address = info.lookup(name);
            if (address === undefined) {
                try {
                    address = this.engine.resolveAddress(name);
                } catch {
                    // neither a symbol nor an address
                }
            }
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

    /** A slot's address, and its sideways bank if it is one. */
    _pcOf(slot) {
        return slot < 0x10000 ? [slot, undefined] : [0x8000 + ((slot - 0x10000) & 0x3fff), (slot - 0x10000) >> 14];
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
        const p = this._period;
        if (prev) {
            const spent = now - prev.cycles;
            const node = this.frames.at(-1).node;
            this.cycles[prev.slot] += spent;
            this.total += spent;
            node.self += spent;
            if (prev.idle) {
                this.idleCycles[prev.slot] += spent;
                this.totalIdle += spent;
                node.idle += spent;
            }
            if (p) {
                p.cycles += spent;
                if (prev.idle) p.idle += spent;
                const r = this.routineOf(prev.pc, prev.bank);
                p.routines.set(r, (p.routines.get(r) ?? 0) + spent);
                add(p.slots, prev.slot, spent, prev.idle);
                add(p.nodes, node.id, spent, prev.idle);
            }
        }
        // Frames left: the stack is back above where they were entered.
        const frames = this.frames;
        while (frames.length > 1 && cpu.s > frames.at(-1).s) {
            const f = frames.pop();
            if (f.site >= 0) {
                const took = now - f.start;
                const idle = this.totalIdle - f.idleAtStart;
                this.callCycles[f.site] += took;
                this.callIdle[f.site] += idle;
                // A call that spans periods is charged to the one it returns in.
                if (p) addCall(p.calls, f.site, took, idle);
            }
        }
        // Frames entered: by the JSR or BRK just run, or an interrupt just taken.
        let entered = null;
        if (prev && (prev.opcode === Opcode.JSR || prev.opcode === Opcode.BRK)) entered = { name: e.symbolFor(pc) ?? hex(pc), site: prev.slot, interrupt: false };
        else if (prev && e._irqEntry(cpu)) {
            entered = { name: "(interrupt)", site: -1, interrupt: true };
            this.interrupts++;
        }
        if (entered) {
            const parent = frames.at(-1);
            let node = parent.node.children.get(entered.name);
            if (!node) parent.node.children.set(entered.name, (node = this._newNode(entered.name, parent.node, { addr: pc, bank: e.bankAt(pc), interrupt: entered.interrupt })));
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
        this._period = {
            index: this._periodCount++,
            start_frame: this.engine.frameCount,
            cycles: 0,
            idle: 0,
            routines: new Map(), // name -> cycles, for MCP's worst periods
            slots: new Map(), // slot -> [cycles, idle]
            calls: new Map(), // JSR slot -> [cycles, idle] of the calls made from it
            nodes: new Map(), // call node id -> [cycles, idle] of its own code
        };
    }

    _closePeriod() {
        const p = this._period;
        this._period = null;
        if (!p || p.cycles === 0) return;
        this.periods.push({ index: p.index, start_frame: p.start_frame, cycles: p.cycles, idle: p.idle });
        if (this.periods.length > PeriodsKept) this.periods.shift();
        // Kept in full only while among the busiest.
        this.worst = worstOf([...this.worst, p]);
    }

    /** The routine an address is in: its nearest symbol at or before it, or its 256-byte page. */
    routineOf(pc, bank) {
        return this._routineAt(pc, bank).name;
    }

    /** { name, address } of the routine an address is in; no address for a page. */
    _routineAt(pc, bank) {
        const key = bank === undefined ? pc : `${bank}:${pc}`;
        let r = this._routineCache.get(key);
        if (r === undefined) {
            const near = this.engine.debugInfo.nearest(pc, 0x1000, bank) ?? null;
            const os = this.engine._osSymbol(pc);
            if (near && !near.name.startsWith(".")) r = { name: near.name, address: pc - near.offset };
            else if (os && os.offset === 0) r = { name: os.name, address: pc };
            else r = { name: `${bank !== undefined ? `${bank}:` : ""}${hex(pc & 0xff00)}-${hex((pc & 0xff00) | 0xff)}` };
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
            const [pc, bank] = this._pcOf(slot);
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
        const totals = this._nodeTotals();
        const cut = (this.total * treeMinPercent) / 100;
        const shape = (node) => {
            const children = [...node.children.values()].map((c) => ({ node: c, t: totals[c.id].cycles })).sort((a, b) => b.t - a.t);
            const kept = children.filter((c) => c.t >= cut);
            const other = children.filter((c) => c.t < cut).reduce((n, c) => n + c.t, 0);
            const out = { name: node.name, calls: node.calls, cycles: Math.round(totals[node.id].cycles), self_cycles: Math.round(node.self) };
            if (kept.length) out.children = kept.map((c) => shape(c.node));
            if (other) out.other_calls_cycles = Math.round(other);
            return out;
        };
        out.call_tree = shape(this.tree);

        // Periods.
        const periods = this._allPeriods();
        if (periods.length) {
            const busyOf = (p) => p.cycles - p.idle;
            const worst = worstOf(this._worstCandidates());
            out.periods = {
                count: this._countedPeriods(),
                busy_cycles_average: Math.round(periods.reduce((n, p) => n + busyOf(p), 0) / periods.length),
                busiest_cycles: Math.round(busyOf(worst[0] ?? periods[0])),
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

    /**
     * The editor's report: the ZX Spectrum extension's profile view reads
     * this shape, with a BBC Micro's cycles where the Spectrum has T-states.
     * Every source line that ran; the routines, with where each starts, the
     * costliest `maxRoutines`; the call tree as flat nodes, parents first;
     * and the periods, the busiest kept in full.
     */
    editorReport({ maxRoutines = 100 } = {}) {
        const e = this.engine;
        const frameCycles = e.model.cyclesPerSecond / 50;
        const base = { active: this.active, idle: this.idle, unresolved: this.unresolved ?? [], frame_cycles: frameCycles };
        if (!this.hits) return { ...base, frames: 0, cycles: 0, idle_cycles: 0, unmapped_cycles: 0, lines: [], routines: [], call_nodes: [] };

        const entries = function* (p) {
            for (let slot = 0; slot < Slots; slot++) {
                if (p.hits[slot]) yield { slot, hits: p.hits[slot], cycles: p.cycles[slot], idle: p.idleCycles[slot], calls: p.callCycles[slot], callsIdle: p.callIdle[slot] };
            }
        };
        const whole = this._fold(entries(this), maxRoutines);
        const totals = this._nodeTotals();
        const out = {
            ...base,
            frames: e.frameCount - this._firstFrame,
            cycles: Math.round(this.total),
            idle_cycles: Math.round(this.totalIdle),
            unmapped_cycles: Math.round(whole.unmapped),
            lines: whole.lines,
            routines: whole.routines,
            call_nodes: this.nodes.map((n) => {
                const where = n.addr !== undefined ? e.debugInfo.lineFor(n.addr, n.bank) : undefined;
                return {
                    id: n.id,
                    parent: n.parent,
                    name: n.name,
                    addr: n.addr,
                    interrupt: n.interrupt,
                    path: where?.file,
                    line: where?.line,
                    calls: n.calls,
                    self_cycles: Math.round(n.self),
                    idle_cycles: Math.round(n.idle),
                    cycles: Math.round(totals[n.id].cycles),
                };
            }),
        };

        const periods = this._allPeriods();
        if (periods.length) {
            const busyOf = (p) => p.cycles - p.idle;
            // The strip: busy time per period, oldest first, each block the busiest of `bucket`.
            const bucket = Math.max(1, Math.ceil(periods.length / StripMax));
            const strip = [];
            for (let i = 0; i < periods.length; i += bucket) {
                let most = 0;
                for (let j = i; j < periods.length && j < i + bucket; j++) most = Math.max(most, busyOf(periods[j]));
                strip.push(Math.round(most));
            }
            const worst = worstOf(this._worstCandidates());
            out.periods = {
                by: this._periodAddress !== undefined ? "marker" : "frame",
                name: this._periodAddress !== undefined ? this.period : "frame",
                count: this._countedPeriods(),
                busy_cycles_average: Math.round(periods.reduce((n, p) => n + busyOf(p), 0) / periods.length),
                busiest_cycles: Math.round(Math.max(...strip)),
                without_idle: periods.filter((p) => p.idle === 0).length,
                bucket,
                strip,
                worst: worst.map((p) => {
                    const slots = new Set([...p.slots.keys(), ...p.calls.keys()]);
                    const fold = this._fold(
                        [...slots].map((slot) => {
                            const [cycles, idle] = p.slots.get(slot) ?? [0, 0];
                            const [calls, callsIdle] = p.calls.get(slot) ?? [0, 0];
                            return { slot, cycles, idle, calls, callsIdle };
                        }),
                        maxRoutines,
                    );
                    return {
                        index: p.index,
                        start_frame: p.start_frame,
                        cycles: Math.round(p.cycles),
                        idle_cycles: Math.round(p.idle),
                        busy_cycles: Math.round(busyOf(p)),
                        unmapped_cycles: Math.round(fold.unmapped),
                        lines: fold.lines,
                        routines: fold.routines,
                        nodes: [...p.nodes.entries()].map(([id, [cycles, idle]]) => [id, Math.round(cycles), Math.round(idle)]),
                    };
                }),
            };
        }
        return out;
    }

    /**
     * Addresses folded into source lines and routines, for the editor:
     * entries of { slot, hits?, cycles, idle, calls, callsIdle }. Time on an
     * address with no source line is `unmapped`.
     */
    _fold(entries, maxRoutines) {
        const e = this.engine;
        const byLine = new Map();
        const byRoutine = new Map();
        let unmapped = 0;
        for (const x of entries) {
            const [pc, bank] = this._pcOf(x.slot);
            const r = this._routineAt(pc, bank);
            let routine = byRoutine.get(r.name);
            if (!routine) {
                const at = r.address !== undefined ? e.debugInfo.lineFor(r.address, bank) : undefined;
                routine = { name: r.name, path: at?.file, line: at?.line, hits: x.hits === undefined ? undefined : 0, cycles: 0, idle_cycles: 0 };
                byRoutine.set(r.name, routine);
            }
            if (x.hits !== undefined) routine.hits += x.hits;
            routine.cycles += x.cycles;
            routine.idle_cycles += x.idle;
            const where = e.debugInfo.lineFor(pc, bank);
            if (!where) {
                unmapped += x.cycles;
                continue;
            }
            const key = `${where.file}:${where.line}`;
            let l = byLine.get(key);
            if (!l) {
                const named = /\((.*)\)$/.exec(e.describeAddress(pc, bank));
                l = { path: where.file, line: where.line, symbol: named ? named[1] : "", hits: x.hits === undefined ? undefined : 0, cycles: 0, idle_cycles: 0, calls_cycles: 0, calls_idle_cycles: 0 };
                byLine.set(key, l);
            }
            if (x.hits !== undefined) l.hits += x.hits;
            l.cycles += x.cycles;
            l.idle_cycles += x.idle;
            l.calls_cycles += x.calls || 0;
            l.calls_idle_cycles += x.callsIdle || 0;
        }
        const round = (o) => {
            for (const k of ["cycles", "idle_cycles", "calls_cycles", "calls_idle_cycles"]) if (o[k] !== undefined) o[k] = Math.round(o[k]);
            return o;
        };
        const lines = [...byLine.values()].map(round).sort((a, b) => b.cycles - a.cycles);
        let routines = [...byRoutine.values()].map(round).sort((a, b) => b.cycles - a.cycles);
        if (maxRoutines > 0) routines = routines.slice(0, maxRoutines);
        return { lines, routines, unmapped };
    }

    /** Each call node's time, its own and its callees': parents come before children, so one backwards pass. */
    _nodeTotals() {
        const t = this.nodes.map((n) => ({ cycles: n.self, idle: n.idle }));
        for (let i = this.nodes.length - 1; i > 0; i--) {
            const parent = this.nodes[i].parent;
            t[parent].cycles += t[i].cycles;
            t[parent].idle += t[i].idle;
        }
        return t;
    }

    /** The periods counted so far, the one in progress included, as numbers. */
    _allPeriods() {
        const p = this._period;
        return p?.cycles ? [...this.periods, { index: p.index, start_frame: p.start_frame, cycles: p.cycles, idle: p.idle }] : this.periods;
    }

    _countedPeriods() {
        return this._periodCount - (this._period && !this._period.cycles ? 1 : 0);
    }

    /** The periods that may be among the busiest: the kept ones, and the one in progress. */
    _worstCandidates() {
        return this._period?.cycles ? [...this.worst, this._period] : this.worst;
    }
}

/** The busiest periods, busiest first, at most WorstKept. */
function worstOf(periods) {
    return [...periods].sort((a, b) => b.cycles - b.idle - (a.cycles - a.idle)).slice(0, WorstKept);
}

function add(map, key, cycles, idle) {
    const v = map.get(key);
    if (v) {
        v[0] += cycles;
        if (idle) v[1] += cycles;
    } else {
        map.set(key, [cycles, idle ? cycles : 0]);
    }
}

function addCall(map, key, cycles, idle) {
    const v = map.get(key);
    if (v) {
        v[0] += cycles;
        v[1] += idle;
    } else {
        map.set(key, [cycles, idle]);
    }
}
