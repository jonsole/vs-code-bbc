// Stepping backwards: the machine's recent past, kept so it can be gone back
// to exactly.
//
// jsbeeb is deterministic: from a snapshot, the same machine runs the same way
// (its typist runs from the scheduler, the Master's clock is made to read
// emulated time). So the past is kept as checkpoints -- a snapshot every
// quarter second of emulated time, about the last minute of them -- and any instant in
// it is reached by restoring the checkpoint before it and running on, unpaced
// and without breakpoints, to the exact cycle.
//
// Whatever is done to the machine from outside -- a key, typed text, memory or
// a register written, a disc put in -- is kept the same way: a checkpoint taken
// just after it. Running forward through the past restores each one as it is
// reached, so the past replays as it happened; doing something new there
// starts a new timeline, and what came after is dropped.
//
// Going back is a search: each quarter second before where the machine is is run
// again with a hook on every instruction, recording where each started, how
// deep in subroutines and interrupts it was, and where a breakpoint or a
// watched access would have stopped it. The last that matches is where the
// machine goes.

const Opcode = { BRK: 0x00, JSR: 0x20, RTI: 0x40, RTS: 0x60 };

const IntervalSeconds = 0.25;
const WindowSeconds = 60;
const MaxBytes = 160 * 1024 * 1024;

export class History {
    /** @param {import("./engine.mjs").Engine} engine */
    constructor(engine) {
        this.engine = engine;
        this.checkpoints = []; // { cycles, frames, state, keyboard, typist, input, bytes }
        this.head = 0; // the newest instant reached: "live"
        this.bytes = 0;
        this.broken = null; // why there is no history just now (a tape is playing)
        this._deferredSince = null;
        this._counted = new WeakSet(); // arrays already in `bytes`: clean disc tracks are shared between checkpoints
    }

    get cpu() {
        return this.engine.cpu;
    }

    get _cyclesPerSecond() {
        return this.engine.model.cyclesPerSecond;
    }

    /** Start again from here: after a power-on, a load, or a state put back. */
    reset() {
        this.checkpoints = [];
        this.bytes = 0;
        this.head = this.engine.elapsedCycles;
        this.broken = null;
        this._take(false);
        this.engine._updateHooks();
    }

    get inPast() {
        return this.engine.elapsedCycles < this.head;
    }

    get behindCycles() {
        return Math.max(0, this.head - this.engine.elapsedCycles);
    }

    get start() {
        return this.checkpoints[0]?.cycles ?? this.head;
    }

    /** The next checkpoint ahead that holds something done from outside, while in the past. */
    get nextInput() {
        if (!this.inPast) return null;
        const now = this.engine.elapsedCycles;
        return this.checkpoints.find((c) => c.input && c.cycles > now) ?? null;
    }

    /** How far the machine may run before the next checkpoint is due: the most a slice should be. */
    get cyclesToCheckpoint() {
        const last = this.checkpoints.at(-1);
        const due = (last?.cycles ?? 0) + IntervalSeconds * this._cyclesPerSecond;
        return Math.max(1000, due - this.engine.elapsedCycles);
    }

    /** After each slice of running: note how far the machine has got, and checkpoint when it is time. */
    afterSlice() {
        const now = this.engine.elapsedCycles;
        if (this.cpu.tapeInterface?.tapeRunning) {
            // A moving tape is not in jsbeeb's snapshots: its past cannot be replayed.
            if (!this.broken) {
                this.checkpoints = [];
                this.bytes = 0;
                this.broken = "the tape is playing, and a playing tape can't be gone back over";
            }
            this.head = now;
            return;
        }
        if (this.broken) return this.reset();
        if (now <= this.head) return;
        this.head = now;
        const last = this.checkpoints.at(-1);
        if (last && now - last.cycles < IntervalSeconds * this._cyclesPerSecond) return;
        // Not in an interrupt handler if it can be helped (I set), so the
        // search can count interrupt depth from zero at each checkpoint.
        if (this.cpu.p.i) {
            this._deferredSince ??= now;
            if (now - this._deferredSince < 4 * IntervalSeconds * this._cyclesPerSecond) return;
        }
        this._deferredSince = null;
        this._take(false);
    }

    /** Something was done to the machine from outside: in the past, that starts a new timeline. */
    mutated() {
        if (this.broken) return;
        const now = this.engine.elapsedCycles;
        if (now < this.head) this._truncate(now);
        this.head = Math.max(this.head, now);
        this._take(true);
        this.engine._updateHooks();
    }

    _truncate(now) {
        while (this.checkpoints.length > 1 && this.checkpoints.at(-1).cycles >= now) {
            this.bytes -= this.checkpoints.pop().bytes;
        }
        this.head = now;
    }

    _take(input) {
        const cpu = this.cpu;
        const now = this.engine.elapsedCycles;
        // One instant, one checkpoint: the newest says how the machine was left.
        if (this.checkpoints.at(-1)?.cycles === now) this.bytes -= this.checkpoints.pop().bytes;
        const state = cpu.snapshotState({ includeRoms: true });
        // Sideways ROM and RAM, 256K, mostly never change: share the last
        // checkpoint's copy while they are the same.
        const prev = this.checkpoints.at(-1)?.state.roms;
        if (prev && equalBytes(prev, state.roms)) state.roms = prev;
        const typist = this.engine.machine.typist;
        const cp = {
            cycles: now,
            frames: this.engine.frameCount,
            state,
            keyboard: cpu.keyboardInterface.keyboardState?.(),
            keyboardEnabled: cpu.keyboardInterface.keyboardEnabled,
            typist: {
                keys: [...typist._keys],
                lastKey: typist._lastKey,
                clocksPerMs: typist._clocksPerMs,
                due: typist._task.scheduled() ? typist._task.expireEpoch - cpu.scheduler.epoch : null,
            },
            input,
            bytes: stateBytes(state, this._counted),
        };
        this.checkpoints.push(cp);
        this.bytes += cp.bytes;
        this._trim();
    }

    _trim() {
        const oldest = this.head - WindowSeconds * this._cyclesPerSecond;
        while (this.checkpoints.length > 1 && (this.checkpoints[1].cycles <= oldest || this.bytes > MaxBytes)) {
            this.bytes -= this.checkpoints.shift().bytes;
        }
    }

    /** Put a checkpoint back, keys held and text being typed included. */
    restore(cp) {
        const cpu = this.cpu;
        const engine = this.engine;
        cpu.restoreState(cp.state);
        if (cp.keyboard) cpu.keyboardInterface.restoreKeyboard(cp.keyboard);
        cpu.keyboardInterface.keyboardEnabled = cp.keyboardEnabled;
        const typist = engine.machine.typist;
        typist._task.cancel();
        typist._keys = [...cp.typist.keys];
        typist._lastKey = cp.typist.lastKey;
        typist._clocksPerMs = cp.typist.clocksPerMs;
        if (cp.typist.due !== null) typist._task.schedule(cp.typist.due);
        cpu.breakpointResume = false;
        engine._frameOffset = engine.session.frameCount - cp.frames;
    }

    _checkpointAtOrBefore(cycles) {
        for (let i = this.checkpoints.length - 1; i >= 0; i--) if (this.checkpoints[i].cycles <= cycles) return i;
        return -1;
    }

    /**
     * Run from the checkpoint at index `i` to the first instruction boundary
     * at or after `until`, with `visit(pc, opcode, cycles)` called at each
     * boundary on the way (the last one included) and the access hooks given.
     */
    _replay(i, until, { visit, read, write } = {}) {
        const engine = this.engine;
        const cpu = this.cpu;
        this.restore(this.checkpoints[i]);
        if (engine.elapsedCycles >= until && !visit) return;
        const hooks = [];
        let done = false;
        engine._suspendHooks(true);
        engine._replaying = true;
        try {
            hooks.push([
                cpu.debugInstruction,
                cpu.debugInstruction.add((pc, opcode) => {
                    const now = engine.elapsedCycles;
                    visit?.(pc, opcode, now);
                    done = now >= until;
                    return done;
                }),
            ]);
            if (read) hooks.push([cpu.debugRead, cpu.debugRead.add((addr, val) => (read(addr, val), false))]);
            if (write) hooks.push([cpu.debugWrite, cpu.debugWrite.add((addr, val) => (write(addr, val), false))]);
            let guard = 0;
            while (!done) {
                if (!cpu.execute(Math.max(1, until - engine.elapsedCycles) + 64)) cpu.targetCycles = cpu.currentCycles;
                if (++guard > 1e6) throw new Error("Replay ran away");
            }
        } finally {
            for (const [hook, fn] of hooks) hook.remove(fn);
            engine._replaying = false;
            engine._suspendHooks(false);
        }
        cpu.breakpointResume = true;
    }

    /** Go to an instant in the history. */
    seek(cycles) {
        const i = this._checkpointAtOrBefore(cycles);
        if (i < 0) throw new Error("That is before the start of the history");
        this._replay(i, cycles);
    }

    /**
     * Search back from where the machine is, a checkpoint's stretch at a time,
     * newest first. `scan(segment)` gets each stretch's record -- every
     * instruction boundary with its depth, and the hits found -- and returns
     * the instant to go to, or undefined to look further back. `ref` carries
     * depths from one stretch to the one before.
     */
    searchBack(scan, { watches = false, writes, banks = false } = {}) {
        if (this.broken) throw new Error(`No history: ${this.broken}`);
        const engine = this.engine;
        const from = engine.elapsedCycles;
        let end = from;
        let i = this._checkpointAtOrBefore(from);
        // Where the machine is now sits at the end of the stretch it is in;
        // if that is a checkpoint, the search starts in the stretch before.
        if (i > 0 && this.checkpoints[i].cycles === from) i--;
        let found;
        try {
            for (; i >= 0; i--) {
                const seg = this._record(i, end, { watches, writes, banks });
                found = scan(seg, i === 0);
                if (found !== undefined) break;
                end = this.checkpoints[i].cycles;
            }
        } finally {
            // Wherever the search left the machine, put it where it is going.
            this.seek(found ?? from);
        }
        return found;
    }

    /** Replay one stretch, recording every boundary and the hits. */
    _record(i, end, { watches, writes, banks }) {
        const engine = this.engine;
        const cpu = this.cpu;
        const seg = { cycles: [], pc: [], depth: [], irq: [], bank: [], hits: [], end };
        let depth = 0;
        const irqStack = [];
        let prevOpcode = -1;
        let first = true;
        let pendingWatch = null;
        const bpCheck = engine._bpByAddress.size > 0;
        this._replay(i, end, {
            visit: (pc, opcode, now) => {
                if (!first) {
                    if (prevOpcode === Opcode.JSR || prevOpcode === Opcode.BRK) depth++;
                    else if (prevOpcode === Opcode.RTS || prevOpcode === Opcode.RTI) depth--;
                    while (irqStack.length && depth <= irqStack.at(-1)) irqStack.pop();
                    if (engine._irqEntry(cpu)) {
                        irqStack.push(depth);
                        depth++;
                    }
                }
                first = false;
                prevOpcode = opcode;
                seg.cycles.push(now);
                seg.pc.push(pc);
                seg.depth.push(depth);
                seg.irq.push(irqStack.length);
                if (banks) seg.bank.push(cpu.romsel & 0x0f);
                if (pendingWatch) {
                    // A watched access stops after its instruction: here.
                    seg.hits.push({ cycles: now, ...pendingWatch });
                    pendingWatch = null;
                }
                if (bpCheck && now < end) {
                    const bps = engine._breakpointsHitAt(pc);
                    if (bps.length) seg.hits.push({ cycles: now, kind: "breakpoint", bps, pc });
                }
            },
            read: watches
                ? (addr, val) => {
                      const w = engine._matchWatch("read", addr, val);
                      if (w && !pendingWatch) pendingWatch = { kind: "watch", ...w, by: seg.pc.at(-1) };
                  }
                : undefined,
            write:
                watches || writes !== undefined
                    ? (addr, val) => {
                          if (writes !== undefined && addr === writes) {
                              // A write is found before it happens: at its instruction's start.
                              seg.hits.push({ cycles: seg.cycles.at(-1), kind: "write", address: addr, old: engine.peek(addr), new: val, by: seg.pc.at(-1) });
                          }
                          if (watches) {
                              const w = engine._matchWatch("write", addr, val);
                              if (w && !pendingWatch) pendingWatch = { kind: "watch", ...w, by: seg.pc.at(-1) };
                          }
                      }
                    : undefined,
        });
        return seg;
    }

    status() {
        const cps = this._cyclesPerSecond;
        const frame = cps / 50;
        return {
            live: !this.inPast,
            available: !this.broken,
            note: this.broken ?? undefined,
            behind_cycles: this.behindCycles,
            frames_behind: Math.round(this.behindCycles / frame),
            frames_available: Math.round((this.head - this.start) / frame),
            seconds_available: Math.round(((this.head - this.start) / cps) * 10) / 10,
            checkpoints: this.checkpoints.length,
            bytes: this.bytes,
        };
    }
}

function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    const n = a.length >> 2;
    const wa = new Uint32Array(a.buffer, a.byteOffset, n);
    const wb = new Uint32Array(b.buffer, b.byteOffset, n);
    for (let i = 0; i < n; i++) if (wa[i] !== wb[i]) return false;
    for (let i = n << 2; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function stateBytes(state, seen) {
    let n = 0;
    const walk = (v) => {
        if (!v || typeof v !== "object" || seen.has(v)) return;
        seen.add(v);
        if (ArrayBuffer.isView(v)) {
            n += v.byteLength;
            return;
        }
        for (const k in v) walk(v[k]);
    };
    walk(state);
    return n;
}
