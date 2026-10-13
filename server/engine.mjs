// The one live BBC Micro: jsbeeb's machine, run in real time on this
// process's event loop, with everything a debugger needs layered on top of it.
//
// Both front ends (DAP and MCP) drive the machine only through this class,
// and both hear about every stop through its "stopped" event, so a debugger
// window and an MCP client can share one machine and stay in agreement.
//
// Running: the machine runs in slices from a timer. Each slice is as many
// cycles as the wall clock says have passed since the last (capped, so a busy
// host slows the machine rather than making it lurch), and between slices the
// event loop serves the protocols. `warp` drops the pacing.
//
// Stopping: jsbeeb's CPU calls a debug hook before each instruction while one
// is installed, and a hook returning true stops the CPU before that
// instruction runs. One hook here serves breakpoints, logpoints and stepping,
// and is installed only while one of them needs it, so a machine with nothing
// to watch for stays on jsbeeb's fast path. Watchpoints use the read and write
// hooks the same way; a watchpoint stops the CPU after the instruction that
// touched the memory.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MachineSession } from "../vendor/jsbeeb/src/machine-session.js";
import { findModel, allModels } from "../vendor/jsbeeb/src/models.js";
import { keyCodes } from "../vendor/jsbeeb/src/keymap.js";
import { compile, parseNumber } from "./expr.mjs";
import { DebugInfo } from "./debug_info.mjs";
import { discFor } from "../vendor/jsbeeb/src/fdc.js";
import { createSnapshot, restoreSnapshot, snapshotToJSON, snapshotFromJSON } from "../vendor/jsbeeb/src/snapshot.js";
import { encodePng } from "./png.mjs";

const FbWidth = 1024;
const FbHeight = 625;
const SliceMs = 5;
const MaxSliceCycles = 100000; // 50ms of 2MHz: the most one slice will catch up

const Opcode = { BRK: 0x00, JSR: 0x20, RTI: 0x40, RTS: 0x60 };
const BreakKey = "F12";

export const PackageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function hex(n, digits = 4) {
    return "&" + (n >>> 0).toString(16).toUpperCase().padStart(digits, "0");
}

/** A BBC key by KeyboardEvent.code ("KeyA"), by jsbeeb's name ("SHIFT", "RETURN"), or a single character. */
export function resolveKeyCode(key) {
    if (typeof key !== "string" || !key) throw new Error("No key given");
    const values = new Set(Object.values(keyCodes));
    if (values.has(key)) return key;
    const upper = key.toUpperCase().replace(/[\s-]+/g, "_");
    const aliases = {
        RETURN: "Enter",
        SHIFT: "ShiftLeft",
        CTRL: "ControlLeft",
        CONTROL: "ControlLeft",
        CAPS_LOCK: "CapsLock",
        SHIFT_LOCK: "AltLeft",
        DELETE: "Backspace",
        COPY: "End",
        BREAK: "F12",
        ESC: "Escape",
        F0: "F10",
    };
    if (aliases[upper] && values.has(aliases[upper])) return aliases[upper];
    if (keyCodes[upper]) return keyCodes[upper];
    if (/^[A-Z]$/.test(upper)) return "Key" + upper;
    if (/^[0-9]$/.test(upper)) return "Digit" + upper;
    if (/^F[0-9]$/.test(upper)) return upper;
    const punctuation = { " ": "Space", ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon", "-": "Minus" };
    if (punctuation[key]) return punctuation[key];
    throw new Error(`Unknown key "${key}": use a KeyboardEvent.code such as "KeyA", or a name such as RETURN, SHIFT, ESCAPE`);
}

export class Engine extends EventEmitter {
    constructor({ model = "B-DFS1.2", warp = false } = {}) {
        super();
        this.modelName = model;
        this.warp = warp;
        this.session = null;
        this.running = false;
        this.debugInfo = new DebugInfo();
        this.programPath = null;

        // Breakpoints come in groups an owner replaces whole: DAP's per source
        // file, its instruction and function breakpoints, and MCP's own.
        this._bpGroups = new Map(); // owner -> [{ address, condition, hitCondition, logMessage, hits }]
        this._bpByAddress = new Map(); // address -> [bp]
        this._watchpoints = new Map(); // id -> { id, owner, address, length, access, condition, hits }
        this._nextWatchId = 1;
        this._step = null; // the step in progress, if any
        this._pendingStop = null; // why the hooks stopped the CPU
        this._lastStop = { reason: "entry", description: "Powered on" };
        this._timer = null;
        this._frameListeners = new Set();
        this._lastFrameSeen = 0;
        this._log = [];
        this._logSeq = 0;
    }

    async init() {
        await this._create(this.modelName);
    }

    async _create(modelName) {
        if (!findModel(modelName)) {
            const names = allModels.map((m) => m.synonyms?.[0] ?? m.name).join(", ");
            throw new Error(`Unknown model "${modelName}". Try one of: ${names}`);
        }
        const wasRunning = this.running;
        this._halt();
        this.session = new MachineSession(modelName);
        await this.session.initialise();
        this.modelName = modelName;
        this.cpu = this.session._machine.processor;
        this.machine = this.session._machine;
        this._lastFrameSeen = this.session.frameCount;
        this._installHooks();
        if (wasRunning) this.resume();
    }

    get model() {
        return this.cpu.model;
    }

    // -----------------------------------------------------------------------
    // Running

    resume({ internal = false } = {}) {
        if (this.running) return;
        this.running = true;
        this._pendingStop = null;
        // Skip the hooks for the instruction at PC: continuing from a breakpoint must not stop on it again.
        this.cpu.breakpointResume = true;
        this._lastTick = performance.now();
        this.emit("continued", { internal });
        this._schedule(0);
    }

    /** Stop a running machine and say so, as a pause. */
    pause(description = "Paused", { internal = false } = {}) {
        if (!this.running) return false;
        this._halt();
        this._stopped({ reason: "pause", description, internal });
        return true;
    }

    _halt() {
        this.running = false;
        this._step = null;
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
        this._updateHooks();
    }

    _schedule(ms) {
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(() => this._tick(), ms);
    }

    _tick() {
        this._timer = null;
        if (!this.running) return;
        const now = performance.now();
        const cps = this.model.cyclesPerSecond;
        let cycles;
        if (this.warp || this._step?.fast) {
            cycles = MaxSliceCycles * 4;
        } else {
            cycles = Math.min(MaxSliceCycles, Math.max(1000, Math.round(((now - this._lastTick) / 1000) * cps)));
        }
        this._lastTick = now;
        const stoppedEarly = !this.cpu.execute(cycles);
        if (stoppedEarly) this.cpu.targetCycles = this.cpu.currentCycles;
        this._checkFrame();
        if (stoppedEarly) {
            const stop = this._pendingStop ?? { reason: "pause", description: "Stopped" };
            if (stop.reason === "step" && this._step?.internal) stop.internal = true;
            this._halt();
            this._stopped(stop);
            return;
        }
        if (this._step?.deadline !== undefined && this.elapsedCycles > this._step.deadline) {
            const step = this._step;
            this._halt();
            this._stopped({ reason: "step", description: `${step.kind} gave up after ${step.limitSeconds}s`, internal: step.internal, timedOut: true });
            return;
        }
        const spent = performance.now() - now;
        this._schedule(this.warp || this._step?.fast ? 0 : Math.max(0, SliceMs - spent));
    }

    get elapsedCycles() {
        return this.machine.elapsedCycles;
    }

    _stopped(stop) {
        this._lastStop = { ...stop, pc: this.cpu.pc };
        this.emit("stopped", this._lastStop);
    }

    get lastStop() {
        return this._lastStop;
    }

    /**
     * Run until stopped, then resolve with the stop. Resolves at once if the
     * machine is already stopped and `start` is false.
     */
    waitForStop(timeoutMs) {
        if (!this.running) return Promise.resolve(this._lastStop);
        return new Promise((resolve) => {
            let timer;
            const onStop = (s) => {
                clearTimeout(timer);
                resolve(s);
            };
            this.once("stopped", onStop);
            if (timeoutMs !== undefined) {
                timer = setTimeout(() => {
                    this.off("stopped", onStop);
                    resolve(null);
                }, timeoutMs);
            }
        });
    }

    // -----------------------------------------------------------------------
    // Stepping. Every step skips over interrupt handlers: an interrupt taken
    // part way is run to its RTI as if it were one instruction.

    stepInstruction() {
        this._startStep({ kind: "Step", done: () => true });
    }

    stepOver() {
        const pc = this.cpu.pc;
        if (this.cpu.peekmem(pc) !== Opcode.JSR) return this.stepInstruction();
        const s = this.cpu.s;
        const ret = (pc + 3) & 0xffff;
        // Back at the instruction after the JSR with the stack where it was: the
        // subroutine has returned, however it got there.
        this._startStep({ kind: "Step over", done: (cpu) => cpu.pc === ret && cpu.s === s });
    }

    stepOut() {
        const s = this.cpu.s;
        // The first RTS or RTI that leaves the stack above where it is now.
        this._startStep({
            kind: "Step out",
            done: (cpu, prevOpcode) => (prevOpcode === Opcode.RTS || prevOpcode === Opcode.RTI) && cpu.s > s,
        });
    }

    /** Run N instructions (counted the same way, interrupts as one). */
    stepCount(n) {
        let left = Math.max(1, n | 0);
        this._startStep({ kind: `Step ${n}`, done: () => --left === 0 });
    }

    /** Run until PC reaches an address (a temporary breakpoint). */
    runTo(address, { internal = false, limitSeconds = 20 } = {}) {
        address &= 0xffff;
        this._startStep({ kind: `Run to ${hex(address)}`, done: (cpu) => cpu.pc === address, interrupts: true, internal, limitSeconds });
    }

    _startStep({ kind, done, interrupts = false, limitSeconds = 20, internal = false }) {
        if (this.running) this._halt();
        this._step = {
            kind,
            done,
            interrupts, // stop inside interrupt handlers too
            irq: null, // the interrupt being skipped: { ret, s }
            prevOpcode: -1,
            limitSeconds,
            deadline: this.elapsedCycles + limitSeconds * this.model.cyclesPerSecond,
            fast: true,
            internal, // a run the server makes for itself (loading), not one the user asked for
        };
        this._updateHooks();
        this.resume({ internal });
    }

    _irqEntry(cpu) {
        // An interrupt has just been taken if PC is at a vector's target and the
        // status byte it pushed has B clear (BRK pushes it set).
        const pc = cpu.pc;
        const irqv = cpu.peekmem(0xfffe) | (cpu.peekmem(0xffff) << 8);
        const nmiv = cpu.peekmem(0xfffa) | (cpu.peekmem(0xfffb) << 8);
        if (pc !== irqv && pc !== nmiv) return null;
        const sp = cpu.s;
        const pushedP = cpu.peekmem(0x100 + ((sp + 1) & 0xff));
        if (pushedP & 0x10) return null;
        const ret = cpu.peekmem(0x100 + ((sp + 2) & 0xff)) | (cpu.peekmem(0x100 + ((sp + 3) & 0xff)) << 8);
        return { ret, s: (sp + 3) & 0xff };
    }

    // -----------------------------------------------------------------------
    // Hooks

    _installHooks() {
        this._instrHook = (pc, opcode) => this._onInstruction(pc, opcode);
        this._readHook = (addr, val) => this._onAccess("read", addr, val);
        this._writeHook = (addr, val) => this._onAccess("write", addr, val);
        this._hooksOn = { instr: false, read: false, write: false };
        this._updateHooks();
    }

    _updateHooks() {
        if (!this.cpu) return;
        const wantInstr = this._bpByAddress.size > 0 || this._step !== null;
        const watches = [...this._watchpoints.values()];
        const wantRead = watches.some((w) => w.access !== "write");
        const wantWrite = watches.some((w) => w.access !== "read");
        const toggle = (key, want, hook, fn) => {
            if (want === this._hooksOn[key]) return;
            if (want) hook.add(fn);
            else hook.remove(fn);
            this._hooksOn[key] = want;
        };
        toggle("instr", wantInstr, this.cpu.debugInstruction, this._instrHook);
        toggle("read", wantRead, this.cpu.debugRead, this._readHook);
        toggle("write", wantWrite, this.cpu.debugWrite, this._writeHook);
    }

    _onInstruction(pc, opcode) {
        const step = this._step;
        if (step) {
            const prev = step.prevOpcode;
            step.prevOpcode = opcode;
            if (step.irq) {
                if (pc === step.irq.ret && this.cpu.s === step.irq.s) step.irq = null;
                else return this._checkBreakpoint(pc);
            } else if (!step.interrupts) {
                const irq = this._irqEntry(this.cpu);
                if (irq) {
                    step.irq = irq;
                    return this._checkBreakpoint(pc);
                }
            }
            if (step.done(this.cpu, prev)) {
                this._pendingStop = { reason: "step", description: step.kind };
                return true;
            }
        }
        return this._checkBreakpoint(pc);
    }

    _checkBreakpoint(pc) {
        const bps = this._bpByAddress.get(pc);
        if (!bps) return false;
        let stop = null;
        for (const bp of bps) {
            if (bp.condition && !this._safeEval(bp.compiled, bp)) continue;
            bp.hits++;
            if (bp.hitCondition && !hitConditionMet(bp.hitCondition, bp.hits)) continue;
            if (bp.logMessage) {
                this._logpoint(bp, pc);
                continue;
            }
            stop ??= {
                reason: bp.kind === "function" ? "function breakpoint" : bp.kind === "instruction" ? "instruction breakpoint" : "breakpoint",
                description: `Breakpoint at ${this.describeAddress(pc)}`,
                breakpointIds: [],
                internal: undefined,
            };
            stop.breakpointIds.push(bp.id);
            stop.internal = (stop.internal ?? true) && bp.internal;
        }
        if (stop) {
            this._pendingStop = stop;
            return true;
        }
        return false;
    }

    _onAccess(access, addr, val) {
        for (const w of this._watchpoints.values()) {
            if (w.access !== "readwrite" && w.access !== access) continue;
            if (addr < w.address || addr >= w.address + w.length) continue;
            if (w.condition && !this._safeEval(w.compiled, w, { value: val })) continue;
            w.hits++;
            this._pendingStop = {
                reason: "data breakpoint",
                description: `${access === "read" ? "Read" : "Write"} of ${hex(val, 2)} at ${this.describeAddress(addr)} by the instruction at ${hex(this.cpu.pc)}`,
                breakpointIds: [w.id],
                access,
                address: addr,
                value: val,
            };
            return true;
        }
        return false;
    }

    _safeEval(compiled, owner, extra) {
        try {
            return compiled(this._exprContext(extra)) !== 0;
        } catch (e) {
            owner.error = e.message;
            return true; // a broken condition stops, so the user sees it
        }
    }

    _logpoint(bp, pc) {
        const text = bp.logMessage.replace(/\{([^}]+)\}/g, (_, e) => {
            try {
                const v = this.evaluate(e);
                return hex(v, v > 0xff ? 4 : 2);
            } catch (err) {
                return `<${err.message}>`;
            }
        });
        const entry = { seq: ++this._logSeq, pc, owner: bp.owner, text };
        this._log.push(entry);
        if (this._log.length > 2000) this._log.splice(0, this._log.length - 2000);
        this.emit("output", entry);
    }

    log(since = 0, max = 200) {
        return this._log.filter((e) => e.seq > since).slice(0, max);
    }

    // -----------------------------------------------------------------------
    // Breakpoints and watchpoints

    /**
     * Replace one owner's breakpoints. Each spec: { address, condition?, hitCondition?, logMessage?, kind? }.
     * Returns them with ids and `verified`, in the order given.
     */
    setBreakpoints(owner, specs) {
        const list = specs.map((s) => {
            const bp = {
                id: s.id ?? Engine.newBreakpointId(),
                owner,
                kind: s.kind ?? "source",
                address: s.address & 0xffff,
                condition: s.condition || undefined,
                hitCondition: s.hitCondition || undefined,
                logMessage: s.logMessage || undefined,
                internal: !!s.internal, // the server's own, e.g. a launch's stopAt: its stop is not announced
                hits: 0,
                verified: true,
            };
            if (bp.condition) {
                try {
                    bp.compiled = compile(bp.condition);
                } catch (e) {
                    bp.verified = false;
                    bp.message = `Condition: ${e.message}`;
                }
            }
            return bp;
        });
        this._bpGroups.set(owner, list);
        this._rebuildBreakpoints();
        return list;
    }

    breakpoints(owner) {
        if (owner !== undefined) return this._bpGroups.get(owner) ?? [];
        return [...this._bpGroups.values()].flat();
    }

    _rebuildBreakpoints() {
        this._bpByAddress.clear();
        for (const list of this._bpGroups.values()) {
            for (const bp of list) {
                if (!bp.verified) continue;
                if (!this._bpByAddress.has(bp.address)) this._bpByAddress.set(bp.address, []);
                this._bpByAddress.get(bp.address).push(bp);
            }
        }
        this._updateHooks();
    }

    /** access: "read" | "write" | "readwrite" */
    addWatchpoint({ owner = "mcp", address, length = 1, access = "write", condition }) {
        if (!["read", "write", "readwrite"].includes(access)) throw new Error(`access must be read, write or readwrite`);
        const w = { id: this._nextWatchId++, owner, address: address & 0xffff, length: Math.max(1, length | 0), access, condition, hits: 0 };
        if (condition) w.compiled = compile(condition);
        this._watchpoints.set(w.id, w);
        this._updateHooks();
        return w;
    }

    removeWatchpoint(id) {
        const ok = this._watchpoints.delete(id);
        this._updateHooks();
        return ok;
    }

    clearWatchpoints(owner) {
        for (const [id, w] of this._watchpoints) if (owner === undefined || w.owner === owner) this._watchpoints.delete(id);
        this._updateHooks();
    }

    watchpoints() {
        return [...this._watchpoints.values()].map(({ compiled, ...w }) => w);
    }

    // -----------------------------------------------------------------------
    // State

    registers() {
        const c = this.cpu;
        return { pc: c.pc, a: c.a, x: c.x, y: c.y, s: c.s, p: c.p.asByte() };
    }

    setRegister(name, value) {
        const c = this.cpu;
        const n = name.toLowerCase();
        if (n === "pc") c.pc = value & 0xffff;
        else if (n === "a" || n === "x" || n === "y") c[n] = value & 0xff;
        else if (n === "s" || n === "sp") c.s = value & 0xff;
        else if (n === "p") c.p.setFromByte(value & 0xff);
        else if (n.length === 1 && "czidvn".includes(n)) c.p[n] = !!value;
        else throw new Error(`No register "${name}"`);
    }

    flagsString(p = this.cpu.p.asByte()) {
        return "NV1BDIZC"
            .split("")
            .map((f, i) => (p & (0x80 >> i) ? f : f === "1" ? "1" : "-"))
            .join("");
    }

    /** Memory as the CPU would see it, without the side effects of reading I/O (which reads as &FF). */
    peek(address) {
        return this.cpu.peekmem(address & 0xffff) & 0xff;
    }

    readMemory(address, length, { bank } = {}) {
        const read = () => {
            const out = new Uint8Array(length);
            for (let i = 0; i < length; i++) out[i] = this.peek(address + i);
            return out;
        };
        if (bank === undefined) return read();
        return this.session._withPaging({ bank }, read);
    }

    writeMemory(address, bytes, { bank } = {}) {
        // writemem would fire the write hook, so a watchpoint could stop a machine that is not running.
        const hooked = this._hooksOn.write;
        if (hooked) this.cpu.debugWrite.remove(this._writeHook);
        try {
            this.session.writeMemory(address, Array.from(bytes), bank === undefined ? {} : { bank });
        } finally {
            if (hooked) this.cpu.debugWrite.add(this._writeHook);
        }
    }

    _exprContext(extra = {}) {
        return {
            register: (n) => this.registers()[n],
            peek: (a) => this.peek(a),
            symbol: (name) => (name === "value" && extra.value !== undefined ? extra.value : this.debugInfo.lookup(name)),
        };
    }

    evaluate(text) {
        return compile(text)(this._exprContext());
    }

    /** An address in a form a person can read: &1904 (loop+2) */
    describeAddress(address) {
        const near = this.debugInfo.nearest(address) ?? this._osSymbol(address);
        const base = hex(address);
        if (!near) return base;
        return near.offset ? `${base} (${near.name}+${near.offset})` : `${base} (${near.name})`;
    }

    _osSymbol(address) {
        const name = OsEntryPoints[address];
        return name ? { name, offset: 0 } : undefined;
    }

    symbolFor(address) {
        return this.debugInfo.byAddress.get(address) ?? OsEntryPoints[address];
    }

    /** One instruction: { address, bytes, text, next, target } with BBC-style & hex */
    disassemble(address) {
        address &= 0xffff;
        const [text, next, target] = this.cpu.disassembler.disassemble(address, true);
        const length = Math.max(1, Math.min(3, ((next - address) & 0xffff) || 1));
        const bytes = [];
        for (let i = 0; i < length; i++) bytes.push(this.peek(address + i));
        let shown = text.replace(/\$([0-9A-Fa-f]+)/g, (_, h) => "&" + h.toUpperCase());
        if (target !== undefined) {
            const name = this.symbolFor(target);
            if (name) shown += `  ; ${name}`;
        }
        return { address, bytes, text: shown, next: next & 0xffff, length };
    }

    disassembleRange(address, count) {
        const out = [];
        let a = address & 0xffff;
        for (let i = 0; i < count; i++) {
            const d = this.disassemble(a);
            out.push(d);
            a = d.next;
        }
        return out;
    }

    previousInstruction(address) {
        return this.cpu.disassembler.prevInstruction(address, this.cpu.pc) & 0xffff;
    }

    /**
     * The call stack, read off the 6502 stack: each pair of bytes that is a
     * JSR's return address (the byte two below it is a JSR). The 6502 keeps no frame pointers, so this is a
     * good guess, not a record: data pushed that happens to look like a return
     * address shows up as a frame.
     */
    callStack(max = 32) {
        const cpu = this.cpu;
        const frames = [{ pc: cpu.pc, kind: "current" }];
        let sp = cpu.s;
        while (sp < 0xff && frames.length < max) {
            const lo = cpu.peekmem(0x100 + sp + 1);
            const hi = sp + 2 <= 0xff ? cpu.peekmem(0x100 + sp + 2) : undefined;
            if (hi !== undefined) {
                const pushed = lo | (hi << 8);
                const jsrAt = (pushed - 2) & 0xffff;
                if (cpu.peekmem(jsrAt) === Opcode.JSR) {
                    frames.push({ pc: jsrAt, kind: "jsr", callee: cpu.peekmem(jsrAt + 1) | (cpu.peekmem(jsrAt + 2) << 8), returnTo: (pushed + 1) & 0xffff, sp });
                    sp += 2;
                    continue;
                }
            }
            sp++;
        }
        return frames;
    }

    // -----------------------------------------------------------------------
    // Screen

    /** Called after each slice: tell listeners about a newly painted frame. */
    _checkFrame() {
        const n = this.session.frameCount;
        if (n === this._lastFrameSeen) return;
        this._lastFrameSeen = n;
        for (const l of this._frameListeners) l(n);
    }

    onFrame(listener) {
        this._frameListeners.add(listener);
        return () => this._frameListeners.delete(listener);
    }

    get frameCount() {
        return this.session.frameCount;
    }

    /** The visible part of the last complete frame: { width, height, rgba } */
    frame() {
        const v = this.session._video;
        const left = v.leftBorder;
        const top = v.topBorder;
        const width = FbWidth - left - v.rightBorder;
        const height = FbHeight - top - v.bottomBorder;
        const src = this.session._completeFb8;
        const rgba = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            const from = ((top + y) * FbWidth + left) * 4;
            rgba.set(src.subarray(from, from + width * 4), y * width * 4);
        }
        return { width, height, rgba };
    }

    screenshotPng() {
        const { width, height, rgba } = this.frame();
        return encodePng(rgba, width, height);
    }

    /** What is on screen as text (any mode), read from the VDU stream since it was last read. */
    screenText({ clear = false } = {}) {
        return this.session.drainOutput({ clear });
    }

    // -----------------------------------------------------------------------
    // Keyboard

    keyDown(key) {
        this._cancelTypingForKeys();
        const code = resolveKeyCode(key);
        // BREAK is not in the keyboard matrix: it pulls the reset line, as F12 does in jsbeeb's page.
        if (code === BreakKey) {
            this.session.reset(false);
            this.emit("reset");
            return;
        }
        this.machine.keyDown(code);
    }

    keyUp(key) {
        this._cancelTypingForKeys();
        const code = resolveKeyCode(key);
        if (code !== BreakKey) this.machine.keyUp(code);
    }

    releaseAllKeys() {
        this.session.releaseAllKeys();
    }

    _cancelTypingForKeys() {
        if (this.machine.typist.isTyping) this.machine.typist.cancel();
    }

    /** Queue text (and a RETURN, unless `enter` is false) to be typed as the machine runs. */
    type(text, { enter = true } = {}) {
        const lines = text.replace(/\r\n?/g, "\n");
        this.machine.typist.type(this.model.stringToKeys(enter ? lines + "\n" : lines), true);
    }

    get typing() {
        return this.machine.typist.isTyping;
    }

    // -----------------------------------------------------------------------
    // Machine control and loading

    async reset({ hard = true, model } = {}) {
        if (model && model !== this.modelName) {
            await this._create(model);
        } else {
            this.session.reset(hard);
        }
        this.emit("reset");
    }

    /**
     * Run (unpaced) until the MOS is waiting for a key: the machine has booted
     * to its prompt. Breakpoints are honoured on the way; returns the stop if one
     * of them fired first, else null.
     */
    async bootToPrompt(timeoutSeconds = 30) {
        return this.runUntil(this.model.idleAddress, timeoutSeconds);
    }

    /** Unpaced run to an address, for loading; null on arrival, the stop if something else stopped it. */
    async runUntil(address, timeoutSeconds = 30) {
        this.runTo(address, { internal: true, limitSeconds: timeoutSeconds });
        const stop = await this.waitForStop();
        if (stop.reason === "step" && this.cpu.pc === (address & 0xffff)) return null;
        return stop;
    }

    /** Unpaced run for a span of emulated time; null when it has run, the stop if a breakpoint came first. */
    async runFor(seconds) {
        const until = this.elapsedCycles + seconds * this.model.cyclesPerSecond;
        this._startStep({ kind: "Run", done: () => this.elapsedCycles >= until, interrupts: true, internal: true, limitSeconds: seconds + 1 });
        const stop = await this.waitForStop();
        return stop.reason === "step" && !stop.timedOut ? null : stop;
    }

    /** Announce that the machine, already stopped, has stopped somewhere the user asked for. */
    emitStopAt(description, reason = "entry") {
        this._stopped({ reason, description });
    }

    /** Unpaced run until the typist has delivered everything queued. */
    async runUntilTyped(timeoutSeconds = 30) {
        this._startStep({ kind: "Typing", done: () => !this.machine.typist.isTyping, interrupts: true, internal: true, limitSeconds: timeoutSeconds });
        const stop = await this.waitForStop();
        return stop.reason === "step" && !stop.timedOut ? null : stop;
    }

    loadDisc(file, drive = 0) {
        const data = new Uint8Array(fs.readFileSync(file));
        this.session._machine.processor.fdc.loadDisc(drive, discFor(file, data));
        this.programPath = file;
    }

    async loadTape(file) {
        await this.session.loadTape(file);
        this.programPath = file;
    }

    async loadBasic(source) {
        await this.session.loadBasic(source);
    }

    loadBinary(file, address) {
        const data = fs.readFileSync(file);
        if (address + data.length > 0x10000) throw new Error(`${path.basename(file)} is ${data.length} bytes: too long to load at ${hex(address)}`);
        this.writeMemory(address, data);
        this.programPath = file;
        return data.length;
    }

    /**
     * Save the machine to a file in jsbeeb's own snapshot format, but with the
     * disc's contents kept in it (jsbeeb's page leaves them out and reloads the
     * disc), so the file alone brings the machine back.
     */
    saveSnapshot(file) {
        const snap = createSnapshot(this.cpu, this.model, this.programPath ? { program: this.programPath } : undefined);
        snap.state = this.cpu.snapshotState();
        fs.writeFileSync(file, snapshotToJSON(snap));
        return fs.statSync(file).size;
    }

    async loadSnapshot(file) {
        const snap = snapshotFromJSON(fs.readFileSync(file, "utf8"));
        if (!findModel(snap.model)) throw new Error(`Snapshot is for an unknown model "${snap.model}"`);
        if (findModel(snap.model).name !== this.model.name) await this._create(snap.model);
        restoreSnapshot(this.cpu, this.model, snap);
        this.programPath = snap.media?.program ?? null;
        this.emit("reset");
        return snap.model;
    }

    loadDebugInfo(files, { source } = {}) {
        const kinds = [];
        for (const f of [].concat(files)) kinds.push(this.debugInfo.loadFile(f, { source }));
        this.emit("debugInfo");
        return kinds;
    }

    clearDebugInfo() {
        this.debugInfo = new DebugInfo();
        this.emit("debugInfo");
    }

    resolveAddress(text) {
        if (typeof text === "number") return text & 0xffff;
        const n = parseNumber(text);
        if (n !== undefined) return n & 0xffff;
        return this.evaluate(String(text)) & 0xffff;
    }

    state() {
        const r = this.registers();
        return {
            model: this.model.name,
            running: this.running,
            registers: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, hex(v, k === "pc" ? 4 : 2)])),
            flags: this.flagsString(r.p),
            pc: this.describeAddress(r.pc),
            instruction: this.disassemble(r.pc).text,
            lastStop: this._lastStop,
            cycles: this.elapsedCycles,
            frames: this.frameCount,
            typing: this.typing,
            breakpoints: this.breakpoints().map((b) => ({ id: b.id, owner: b.owner, address: hex(b.address), hits: b.hits, condition: b.condition, logMessage: b.logMessage })),
            watchpoints: this.watchpoints().map((w) => ({ ...w, address: hex(w.address) })),
            callStack: this.callStack().map((f) => this.describeAddress(f.pc)),
            program: this.programPath,
        };
    }

    dispose() {
        this._halt();
        this.removeAllListeners();
    }
}
Engine._nextBpId = 1;
/** Ids are unique across owners, as DAP needs; a client re-setting a breakpoint keeps its id. */
Engine.newBreakpointId = () => Engine._nextBpId++;

function hitConditionMet(cond, hits) {
    const m = /^\s*(>=|>|==|=|%)?\s*(\d+)\s*$/.exec(cond);
    if (!m) return true;
    const n = Number(m[2]);
    switch (m[1]) {
        case ">":
            return hits > n;
        case "%":
            return n > 0 && hits % n === 0;
        case "==":
        case "=":
            return hits === n;
        default:
            return hits >= n;
    }
}

// The MOS's documented entry points, so a JSR into the OS reads as one.
export const OsEntryPoints = {
    0xffb9: "OSRDRM",
    0xffbc: "VDUCHR",
    0xffbf: "OSEVEN",
    0xffc2: "GSINIT",
    0xffc5: "GSREAD",
    0xffc8: "NVRDCH",
    0xffcb: "NVWRCH",
    0xffce: "OSFIND",
    0xffd1: "OSGBPB",
    0xffd4: "OSBPUT",
    0xffd7: "OSBGET",
    0xffda: "OSARGS",
    0xffdd: "OSFILE",
    0xffe0: "OSRDCH",
    0xffe3: "OSASCI",
    0xffe7: "OSNEWL",
    0xffee: "OSWRCH",
    0xfff1: "OSWORD",
    0xfff4: "OSBYTE",
    0xfff7: "OSCLI",
};
