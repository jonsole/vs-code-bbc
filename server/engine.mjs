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
// and is installed only while one of them needs it. (jsbeeb's own hook that
// watches OSWRCH for printed text is always there, so the CPU always takes
// its checked path; the cost is a few percent, and printed text is worth it.)
// Watchpoints use the read and write hooks the same way; a watchpoint stops
// the CPU after the instruction that touched the memory.
//
// Going back: rewind.mjs keeps the recent past as checkpoints, and replays
// from them to any instant in it; see there.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MachineSession } from "../vendor/jsbeeb/src/machine-session.js";
import { findModel, allModels } from "../vendor/jsbeeb/src/models.js";
import { keyCodes, BBC } from "../vendor/jsbeeb/src/keymap.js";
import { ATOM } from "../vendor/jsbeeb/src/keymap-atom.js";
import { compile, parseNumber } from "./expr.mjs";
import { DebugInfo } from "./debug_info.mjs";
import { discFor } from "../vendor/jsbeeb/src/fdc.js";
import { createSnapshot, restoreSnapshot, snapshotToJSON, snapshotFromJSON } from "../vendor/jsbeeb/src/snapshot.js";
import { encodePng } from "./png.mjs";
import { VduTranscript } from "./vdu_transcript.mjs";
import { fontIndex, readScreenText, VduVars } from "./screen_text.mjs";
import { History } from "./rewind.mjs";
import { Trace } from "./trace.mjs";
import { VideoRecorder } from "./video.mjs";
import { Profiler } from "./profiler.mjs";
import { AudioTap } from "./audio.mjs";

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

/** &8000-&BFFF: whichever of the 16 sideways ROM/RAM banks ROMSEL has paged in. */
export function isBanked(address) {
    return address >= 0x8000 && address < 0xc000;
}

export class Engine extends EventEmitter {
    constructor({ model = "B-DFS1.2", warp = false, tube = false } = {}) {
        super();
        this.modelName = model;
        this.tube = tube;
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
        // Who set the machine moving last -- "mcp" or "dap" -- so a debugger
        // can show a stop an agent caused without taking its editor over.
        this.driver = "dap";
        // Real time scaled by this, unless warp: 0.1 a tenth of the speed, 2 double.
        this.speedMultiplier = 1;
        this._cycleDebt = 0;
        // Stop at the first instruction of each interrupt handler.
        this.breakOnInterrupt = false;
        // DAP clients connected, so a tool that resets the machine can say so.
        this.debuggers = 0;
        // The recent past, for stepping backwards.
        this._history = null;
        this._nextInput = null; // in the past: the next checkpoint holding something done from outside
        this._replaying = false; // a replay to an instant in the past, which prints nothing new
        this._frameOffset = 0; // frames painted by replays, which the frame count leaves out
        this._trace = null; // the execution trace, open or the last one closed
        this._paintListeners = new Set(); // called at every frame painted, replays aside
        this._video = null; // the recording, going or the last one
        this.ffmpegPath = "ffmpeg";
        this.profiler = new Profiler(this);
    }

    async init() {
        await this._create(this.modelName);
    }

    async _create(modelName, { tube = this.tube } = {}) {
        if (!findModel(modelName)) {
            const names = allModels.map((m) => m.synonyms?.[0] ?? m.name).join(", ");
            throw new Error(`Unknown model "${modelName}". Try one of: ${names}`);
        }
        const wasRunning = this.running;
        this._halt();
        this.session = new MachineSession(modelName, { tube });
        await this.session.initialise();
        this.modelName = modelName;
        this.tube = tube;
        this.cpu = this.session._machine.processor;
        this.machine = this.session._machine;
        this._lastFrameSeen = this.session.frameCount;
        this._frameOffset = 0;
        // What is printed, in order, for the run tools' `output`.
        this._transcript = new VduTranscript();
        this.machine.onVduChar((c) => {
            if (!this._replaying) this._transcript.write(c);
        });
        // The Master's clock reads emulated time, so a replay reads it the same.
        if (this.cpu.cmos) {
            const base = Date.now();
            this.cpu.cmos.now = () => base + (this.elapsedCycles / this.model.cyclesPerSecond) * 1000;
        }
        // Every frame painted, for a recording; jsbeeb's own listener first.
        const video = this.session._video;
        const paint = video.paint_ext;
        video.paint_ext = (...args) => {
            paint(...args);
            if (!this._replaying) for (const l of this._paintListeners) l();
        };
        // The sound it makes, for get_audio and the screen panel.
        this.audio = new AudioTap(this);
        this._installHooks();
        this._history = new History(this);
        this._history.reset();
        if (wasRunning) this.resume();
    }

    get model() {
        return this.cpu.model;
    }

    // -----------------------------------------------------------------------
    // Running

    /**
     * Run on in real time. With `limitSeconds`, stop by itself after that much
     * emulated time, as a pause with timedOut set: a run waited on that no
     * breakpoint ends must still end.
     */
    resume({ internal = false, limitSeconds } = {}) {
        if (this.running) return;
        this.running = true;
        this._pendingStop = null;
        this._runDeadline = limitSeconds === undefined ? undefined : this.elapsedCycles + limitSeconds * this.model.cyclesPerSecond;
        this._runLimit = limitSeconds;
        this._nextInput = this._history.nextInput;
        this._updateHooks();
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
            cycles = Math.min(MaxSliceCycles * 4, this._history.cyclesToCheckpoint);
        } else {
            // Fractions carried over, so a crawl at a thousandth of the speed still moves.
            this._cycleDebt += ((now - this._lastTick) / 1000) * cps * this.speedMultiplier;
            cycles = Math.min(MaxSliceCycles, Math.floor(this._cycleDebt));
            this._cycleDebt = Math.min(this._cycleDebt - cycles, MaxSliceCycles);
            if (cycles < 1) {
                this._lastTick = now;
                this._schedule(SliceMs);
                return;
            }
        }
        this._lastTick = now;
        const stoppedEarly = !this.cpu.execute(cycles);
        if (stoppedEarly) this.cpu.targetCycles = this.cpu.currentCycles;
        this._checkFrame();
        this.audio.catchUp();
        if (stoppedEarly && this._pendingStop?.reason === "history-input") {
            // Running forward through the past, to where something was done
            // from outside: it is done again, as the checkpoint taken after it.
            const cp = this._pendingStop.checkpoint;
            this._pendingStop = null;
            this._history.restore(cp);
            this._nextInput = this._history.nextInput;
            this._updateHooks();
            this._schedule(0);
            return;
        }
        this._history.afterSlice();
        if (this._hooksStale) {
            this._hooksStale = false;
            this._updateHooks();
        }
        if (stoppedEarly) {
            const stop = this._pendingStop ?? { reason: "pause", description: "Stopped" };
            if (stop.reason === "step" && this._step?.internal) stop.internal = true;
            this._halt();
            this._stopped(stop);
            return;
        }
        if (!this._step && this._runDeadline !== undefined && this.elapsedCycles > this._runDeadline) {
            this._halt();
            this._stopped({ reason: "pause", description: `Ran ${this._runLimit}s without stopping`, timedOut: true });
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
        this._lastStop = { ...stop, pc: this.cpu.pc, driver: this.driver };
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
        // jsbeeb's zero page and stack reads pass the value third, not second:
        // those are plain RAM, so read it.
        this._readHook = (addr, val) => this._onAccess("read", addr, addr < 0x200 ? this.peek(addr) : val);
        this._writeHook = (addr, val) => this._onAccess("write", addr, val);
        this._hooksOn = { instr: false, read: false, write: false };
        this._updateHooks();
    }

    _updateHooks() {
        if (!this.cpu) return;
        const tracing = !!this._trace?.active;
        const wantInstr =
            this._bpByAddress.size > 0 || this._step !== null || this.breakOnInterrupt || this._nextInput !== null || tracing || this.profiler?.active;
        const watches = [...this._watchpoints.values()].filter((w) => w.enabled);
        const wantRead = tracing || watches.some((w) => w.access !== "write");
        const wantWrite = tracing || watches.some((w) => w.access !== "read");
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

    /** Take the engine's hooks out while a replay runs, and put them back after. */
    _suspendHooks(suspend) {
        const hooks = { instr: [this.cpu.debugInstruction, this._instrHook], read: [this.cpu.debugRead, this._readHook], write: [this.cpu.debugWrite, this._writeHook] };
        for (const [key, [hook, fn]] of Object.entries(hooks)) {
            if (!this._hooksOn[key]) continue;
            if (suspend) hook.remove(fn);
            else hook.add(fn);
        }
    }

    setBreakOnInterrupt(on) {
        this.breakOnInterrupt = !!on;
        this._updateHooks();
    }

    _onInstruction(pc, opcode) {
        if (this._nextInput && this.elapsedCycles >= this._nextInput.cycles) {
            this._pendingStop = { reason: "history-input", checkpoint: this._nextInput };
            return true;
        }
        // A trace that closes itself leaves its hooks to be taken out after the slice.
        if (this._trace?.active && this._trace.instruction(pc)) this._hooksStale = true;
        if (this.profiler.active) this.profiler.instruction(pc, opcode);
        if (this.breakOnInterrupt && !this._step?.internal) {
            const irq = this._irqEntry(this.cpu);
            if (irq) {
                this._pendingStop = { reason: "interrupt", description: `Interrupt: the handler at ${this.describeAddress(pc)}, from ${this.describeAddress(irq.ret)}` };
                return true;
            }
        }
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
            if (bp.bank !== undefined && bp.bank !== this.bankAt(pc)) continue;
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

    /**
     * The breakpoints at an address that would stop there now (bank and
     * condition met), hit counts aside: what a search of the past asks.
     */
    _breakpointsHitAt(pc) {
        const bps = this._bpByAddress.get(pc);
        if (!bps) return [];
        return bps.filter((bp) => !bp.logMessage && (bp.bank === undefined || bp.bank === this.bankAt(pc)) && (!bp.condition || this._safeEval(bp.compiled, bp)));
    }

    /** The watchpoint an access sets off, if any: { watchpoint, access, address, old, new }. */
    _matchWatch(access, addr, val) {
        for (const w of this._watchpoints.values()) {
            if (!w.enabled) continue;
            if (w.access !== "readwrite" && w.access !== access) continue;
            if (addr < w.address || addr >= w.address + w.length) continue;
            if (w.bank !== undefined && w.bank !== this.bankAt(addr)) continue;
            // jsbeeb calls the write hook before the byte is stored, so what is
            // there now is the old value.
            const old = access === "write" ? this.peek(addr) : val;
            if (access === "write" && w.onChange && old === val) continue;
            if (w.value !== undefined && val !== w.value) continue;
            if (w.notValue !== undefined && val === w.notValue) continue;
            if (w.condition && !this._safeEval(w.compiled, w, { value: val })) continue;
            return { watchpoint: w.id, access, address: addr, old, new: val };
        }
        return null;
    }

    _watchStop(hit) {
        return {
            reason: "data breakpoint",
            description: `${hit.access === "read" ? "Read" : "Write"} of ${hex(hit.new, 2)} at ${this.describeAddress(hit.address)} by the instruction at ${this.describeAddress(hit.by)}`,
            breakpointIds: [hit.watchpoint],
            watchStop: { watchpoint: hit.watchpoint, access: hit.access, address: hit.address, old: hit.old, new: hit.new, by: hit.by },
        };
    }

    _onAccess(access, addr, val) {
        if (this._trace?.active) this._trace.access(access === "read" ? "R" : "W", addr, val);
        if (this._watchpoints.size === 0) return false;
        const hit = this._matchWatch(access, addr, val);
        if (!hit) return false;
        this._watchpoints.get(hit.watchpoint).hits++;
        // The instruction making the access: where it started, which jsbeeb
        // records before running it -- PC itself has moved on into it.
        this._pendingStop = this._watchStop({ ...hit, by: this.cpu.oldPcArray[this.cpu.oldPcIndex] });
        return true;
    }

    _safeEval(compiled, owner, extra) {
        try {
            return compiled(this._exprContext(extra)) !== 0;
        } catch (e) {
            owner.error = e.message;
            return true; // a broken condition stops, so the user sees it
        }
    }

    /**
     * A logpoint's message filled in: each {expression} as hex, or with a
     * format after a colon as the Spectrum's logpoints have them --
     * {A:d} decimal, {?ptr:c} a character, {peekw(x):w} a 16-bit word, {X:x} hex.
     */
    formatLogMessage(message) {
        return message.replace(/\{([^}]+)\}/g, (_, inside) => {
            const m = /^(.*?):([dcwx])$/.exec(inside.trim());
            const [e, format] = m ? [m[1], m[2]] : [inside, "x"];
            try {
                const v = this.evaluate(e);
                switch (format) {
                    case "d":
                        return String(v);
                    case "c":
                        return v >= 32 && v < 127 ? String.fromCharCode(v) : `\\x${(v & 0xff).toString(16).padStart(2, "0")}`;
                    case "w":
                        return hex(v & 0xffff, 4);
                    default:
                        return hex(v, v > 0xff ? 4 : 2);
                }
            } catch (err) {
                return `<${err.message}>`;
            }
        });
    }

    _logpoint(bp, pc) {
        const text = this.formatLogMessage(bp.logMessage);
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
                // A sideways bank: only while that bank is paged in at the address.
                bank: isBanked(s.address & 0xffff) && Number.isInteger(s.bank) ? s.bank : undefined,
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
    /**
     * access: "read" | "write" | "readwrite". onChange: only a write that
     * changes the value (VS Code's data breakpoints stop on every write, so
     * it is off unless asked for). value / notValue: only an access of, or
     * not of, that byte. enabled: false keeps it, but stops it stopping
     * anything. id: replace that watchpoint, keeping its id and hit count.
     */
    addWatchpoint({ owner = "mcp", address, length = 1, access = "write", condition, onChange = false, value, notValue, bank, enabled = true, id }) {
        if (!["read", "write", "readwrite"].includes(access)) throw new Error(`access must be read, write or readwrite`);
        for (const v of [value, notValue]) {
            if (v !== undefined && !(Number.isInteger(v) && v >= 0 && v <= 255)) throw new Error("a watchpoint watches bytes: the value must be 0-255");
        }
        if (value !== undefined && notValue !== undefined) throw new Error("value and not_value are two answers to the same question");
        const replaced = id !== undefined ? this._watchpoints.get(id) : undefined;
        if (id !== undefined && !replaced) throw new Error(`No watchpoint ${id}`);
        const w = {
            id: replaced ? replaced.id : this._nextWatchId++,
            owner: replaced ? replaced.owner : owner,
            address: address & 0xffff,
            length: Math.max(1, length | 0),
            access,
            condition,
            // A value test asks about every write, including one of the same value again.
            onChange: value === undefined && notValue === undefined && onChange,
            value,
            notValue,
            bank: isBanked(address & 0xffff) && Number.isInteger(bank) ? bank : undefined,
            enabled: enabled !== false,
            hits: replaced ? replaced.hits : 0,
        };
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

    /** Registers as a person reads them, with the counters that say how far the machine has got. */
    registerReport() {
        const r = this.registers();
        return {
            pc: this.describeAddress(r.pc),
            a: hex(r.a, 2),
            x: hex(r.x, 2),
            y: hex(r.y, 2),
            s: hex(r.s, 2),
            p: hex(r.p, 2),
            flags: this.flagsString(r.p),
            instruction: this.disassemble(r.pc).text,
            frame_count: this.frameCount,
            elapsed_cycles: this.elapsedCycles,
        };
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
        this._mutated();
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

    /**
     * `bank` pages a sideways ROM/RAM bank in at &8000-&BFFF for the access, and
     * on a Master `shadow` picks shadow (true) or main (false) RAM at
     * &3000-&7FFF; the map is put back afterwards. Left out, the access sees
     * what the machine has paged in.
     */
    readMemory(address, length, { bank, shadow } = {}) {
        const read = () => {
            const out = new Uint8Array(length);
            for (let i = 0; i < length; i++) out[i] = this.peek(address + i);
            return out;
        };
        if (bank === undefined && shadow === undefined) return read();
        return this.session._withPaging({ bank, shadow }, read);
    }

    writeMemory(address, bytes, { bank, shadow } = {}) {
        // writemem would fire the write hook, so a watchpoint could stop a machine that is not running.
        const hooked = this._hooksOn.write;
        if (hooked) this.cpu.debugWrite.remove(this._writeHook);
        try {
            this.session.writeMemory(address, Array.from(bytes), { bank, shadow });
        } finally {
            if (hooked) this.cpu.debugWrite.add(this._writeHook);
        }
        this._mutated();
    }

    /** What is paged in: romsel (the sideways bank at &8000), and on a Master acccon (bit 2: shadow RAM at &3000). */
    paging() {
        return this.session.pagingState();
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

    /** The sideways bank paged in at an address in &8000-&BFFF, or undefined anywhere else. */
    bankAt(address) {
        return isBanked(address) ? this.cpu.romsel & 0x0f : undefined;
    }

    /**
     * An address in a form a person can read: &1904 (loop+2), and in
     * &8000-&BFFF with its sideways bank in front -- the bank paged in now
     * unless `bank` says which: 4:&8012 (service+3).
     */
    describeAddress(address, bank = this.bankAt(address)) {
        const near = this.debugInfo.nearest(address, 256, bank) ?? this._osSymbol(address);
        const base = (isBanked(address) && bank !== undefined ? `${bank}:` : "") + hex(address);
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

    /** Called at every frame painted (not at most once a slice, as onFrame is); replays aside. */
    onPaint(listener) {
        this._paintListeners.add(listener);
        return () => this._paintListeners.delete(listener);
    }

    onFrame(listener) {
        this._frameListeners.add(listener);
        return () => this._frameListeners.delete(listener);
    }

    /** Frames painted, as the machine's own history has them: a replay of the past does not add to it. */
    get frameCount() {
        return this.session.frameCount - this._frameOffset;
    }

    /** Frames painted, replays included: what a picture listener counts. */
    get paintCount() {
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

    /** The visible picture as a PNG, `scale` times its size (nearest neighbour, so pixels stay crisp). */
    screenshotPng({ scale = 1 } = {}) {
        const { width, height, rgba } = this.frame();
        const k = Math.max(1, Math.min(4, scale | 0));
        if (k === 1) return encodePng(rgba, width, height);
        const out = new Uint8Array(width * k * height * k * 4);
        const src = new Uint32Array(rgba.buffer);
        const dst = new Uint32Array(out.buffer);
        for (let y = 0; y < height * k; y++) {
            const row = ((y / k) | 0) * width;
            for (let x = 0; x < width * k; x++) dst[y * width * k + x] = src[row + ((x / k) | 0)];
        }
        return encodePng(out, width * k, height * k);
    }

    /**
     * What the screen says now, read from screen memory (see screen_text.mjs):
     * MODE 7 exactly, other modes by matching each cell against the MOS font.
     */
    screenText() {
        const vdu = (a) => this.peek(a);
        const mode = vdu(VduVars.mode) & 7;
        const topLeft = vdu(VduVars.topLeft) | (vdu(VduVars.topLeft + 1) << 8);
        const rowBytes = vdu(VduVars.rowBytes) | (vdu(VduVars.rowBytes + 1) << 8);
        const screenStart = vdu(VduVars.screenStartHi) << 8;
        Engine._font ??= fontIndex(fs.readFileSync(path.join(PackageRoot, "vendor/jsbeeb/public/roms/os.rom")).subarray(0, 95 * 8));
        // A Master showing its shadow screen (ACCCON bit 0) shows shadow RAM, not main.
        const shadow = this.model.isMaster && (this.cpu.acccon & 1) !== 0;
        const read = () =>
            readScreenText({ read: (a) => this.peek(a), mode, topLeft, rowBytes, screenStart, font: Engine._font });
        return shadow ? this.session._withPaging({ shadow: true }, read) : read();
    }

    /**
     * What was printed through OSWRCH since the output was last taken, in
     * order, as a transcript (see vdu_transcript.mjs); `clear: false` peeks,
     * leaving it to be taken again.
     */
    takeOutput({ clear = true } = {}) {
        return this._transcript.take({ clear });
    }

    // -----------------------------------------------------------------------
    // Keyboard

    keyDown(key) {
        this._cancelTypingForKeys();
        const code = resolveKeyCode(key);
        // BREAK is not in the keyboard matrix: it pulls the reset line, as F12 does in jsbeeb's page.
        if (code === BreakKey) {
            this.session.reset(false);
            this._mutated();
            this.emit("reset");
            return;
        }
        this.machine.keyDown(code);
        this._mutated();
    }

    keyUp(key) {
        this._cancelTypingForKeys();
        const code = resolveKeyCode(key);
        if (code !== BreakKey) this.machine.keyUp(code);
        this._mutated();
    }

    releaseAllKeys() {
        this.session.releaseAllKeys();
        this._mutated();
    }

    /** The model's own key names and matrix positions: jsbeeb's BBC table, or the Atom's. */
    get keyTable() {
        return this.model.isAtom ? ATOM : BBC;
    }

    /**
     * Press or release one key straight on the keyboard matrix, with no host
     * keyboard layout in between: what a game's own keyboard scan reads. Named
     * one way: `key` (the machine's name: SHIFT, RETURN, COLON_STAR, K1, F0...),
     * `internal` (as OSBYTE 121 takes, X is 66), `inkey` (negative INKEY, X is
     * -67) or `col` and `row`. BREAK is not on the matrix: it resets.
     * Returns the keys that changed, described as keyboardState() does.
     */
    pressMatrixKey(selector, down) {
        if (typeof selector.key === "string" && selector.key.toUpperCase() === "BREAK") {
            if (down) {
                this.session.reset(false);
                this._mutated();
                this.emit("reset");
            }
            return [{ name: "BREAK" }];
        }
        const colRow = this._resolveMatrixKey(selector);
        if (this.typing) {
            throw new Error("Text is still being typed (a breakpoint stopped it part way): run on to let it finish, or release_all_keys to drop it");
        }
        const before = new Set(this.session.heldKeys().map(String));
        if (down) this.session.keyDownRaw(colRow);
        else this.session.keyUpRaw(colRow);
        this._mutated();
        const after = this.session.heldKeys();
        const afterSet = new Set(after.map(String));
        const changed = down ? after.filter((k) => !before.has(String(k))) : [...before].filter((k) => !afterSet.has(k)).map((k) => k.split(",").map(Number));
        return changed.map((k) => this.describeKey(k));
    }

    _resolveMatrixKey({ key, internal, inkey, col, row }) {
        if ((col === undefined) !== (row === undefined)) throw new Error("Give col and row together");
        const given = [key, internal, inkey, col].filter((v) => v !== undefined).length;
        if (given !== 1) throw new Error("Give exactly one of key, internal, inkey, or col and row");
        const table = this.keyTable;
        if (key !== undefined) {
            let name = String(key).toUpperCase().replace(/[\s-]+/g, "_");
            const aliases = { ENTER: "RETURN", CONTROL: "CTRL", CAPS_LOCK: "CAPSLOCK", SHIFT_LOCK: "SHIFTLOCK", ESC: "ESCAPE", BACKSPACE: "DELETE" };
            name = aliases[name] ?? name;
            if (/^[0-9]$/.test(name)) name = "K" + name;
            // The tables are plain objects: "constructor" must not resolve to a function.
            if (!Object.hasOwn(table, name)) throw new Error(`Unknown key "${key}". The ${this.model.name}'s keys: ${Object.keys(table).join(", ")}`);
            return table[name];
        }
        if (col !== undefined) return [col, row];
        if (table !== BBC) throw new Error("Internal key numbers are the BBC's; on the Atom give col and row");
        const number = internal ?? -inkey - 1;
        if (!(number >= 0 && number <= 0x7f)) throw new Error("internal is 0-127, inkey -1 to -128");
        return [number & 15, number >> 4];
    }

    /** A matrix key by position, with its name, and on a BBC its internal and INKEY numbers. */
    describeKey([col, row]) {
        const table = this.keyTable;
        const out = { col, row };
        const name = Object.keys(table).find((k) => table[k][0] === col && table[k][1] === row);
        if (name) out.name = name;
        if (table === BBC) {
            out.internal = (row << 4) | col;
            out.inkey = -(out.internal + 1);
        }
        return out;
    }

    keyboardState() {
        return { held_keys: this.session.heldKeys().map((k) => this.describeKey(k)), typing_pending: this.typing };
    }

    /** Drop whatever is still to be typed; true if there was any. */
    cancelTyping() {
        const was = this.typing;
        if (was) {
            this.machine.typist.cancel();
            this._mutated();
        }
        return was;
    }

    _cancelTypingForKeys() {
        if (this.machine.typist.isTyping) this.machine.typist.cancel();
    }

    /** Queue text (and a RETURN, unless `enter` is false) to be typed as the machine runs. */
    type(text, { enter = true } = {}) {
        const lines = text.replace(/\r\n?/g, "\n");
        this.machine.typist.type(this.model.stringToKeys(enter ? lines + "\n" : lines), true);
        this._mutated();
    }

    get typing() {
        return this.machine.typist.isTyping;
    }

    // -----------------------------------------------------------------------
    // Execution trace (see trace.mjs)

    /** Open a trace file: { path, limit, startPc, watch, symbols }. One at a time. */
    startTrace(opts) {
        if (this._trace?.active) throw new Error(`A trace is already being written to ${this._trace.path}: stop_trace first`);
        this._trace = new Trace(this, opts);
        this._updateHooks();
        return this._trace.status();
    }

    /** Close the trace now, or with `pc`, on reaching that address. */
    stopTrace({ pc } = {}) {
        const t = this._trace;
        if (!t) throw new Error("No trace has been started");
        if (pc !== undefined && t.active) t.stopPc = pc & 0xffff;
        else t.close();
        this._updateHooks();
        return t.status();
    }

    traceStatus() {
        if (!this._trace) return { active: false, rows: 0 };
        this._trace.flush();
        return this._trace.status();
    }

    // -----------------------------------------------------------------------
    // Profile (see profiler.mjs)

    /** "start" (counting from zero), "stop", or "get"; then the report. */
    profile(action = "get", { idle, period, lines, routines, treeMinPercent } = {}) {
        if (action === "start") this.profiler.start({ idle, period });
        else if (action === "stop") this.profiler.stop();
        else if (action !== "get") throw new Error('action is "start", "stop" or "get"');
        this._updateHooks();
        return this.profiler.report({ lines, routines, treeMinPercent });
    }

    /**
     * The same for the editor's heat map and call tree (the DAP `profile`
     * request): `idle` and `period`, when given, apply first and from now
     * on, so a start counts against them from its first instruction.
     */
    profileForEditor(action = "get", { idle, period, maxRoutines = 100 } = {}) {
        if (!["start", "stop", "get"].includes(action)) throw new Error(`profile action must be start, stop or get, not '${action}'`);
        if (idle !== undefined || period !== undefined) this.profiler.configure({ idle, period });
        if (action === "start") this.profiler.start();
        else if (action === "stop") this.profiler.stop();
        this._updateHooks();
        return this.profiler.editorReport({ maxRoutines });
    }

    // -----------------------------------------------------------------------
    // Video (see video.mjs)

    /** Record every frame painted to a file through ffmpeg: { path, seconds, frames, scale }. */
    async startVideo(opts) {
        if (this._video?.active) throw new Error(`Already recording to ${this._video.path}: stop_video first`);
        const v = new VideoRecorder(this, { ...opts, ffmpeg: this.ffmpegPath });
        this._video = v;
        // A missing or failing encoder says so now, not at the end.
        await new Promise((r) => setTimeout(r, 250));
        if (v.error) throw new Error(v.error);
        return v.status();
    }

    async stopVideo() {
        if (!this._video) throw new Error("No video has been started");
        return this._video.stop();
    }

    videoStatus() {
        return this._video ? this._video.status() : { active: false, frames: 0 };
    }

    // -----------------------------------------------------------------------
    // Going back (see rewind.mjs)

    /** Something was done to the machine from outside: the history keeps it. */
    _mutated() {
        if (!this._history || this._replaying) return;
        this._history.mutated();
        this._nextInput = this.running ? this._history.nextInput : null;
        this._updateHooks();
    }

    get history() {
        return this._history;
    }

    _goBack(kind, scan, opts) {
        if (this.running) this.pause(undefined, { internal: true });
        const before = this.elapsedCycles;
        const found = this._history.searchBack(scan, opts);
        this._checkFrame();
        return { moved: this.elapsedCycles !== before, found };
    }

    /**
     * Back `count` instructions: "into" each instruction, "over" the calls
     * returned from (staying in this routine), or "out" to the JSR that
     * entered it. Interrupt handlers are passed over, as forward steps pass
     * them. Returns { moved, steps, note }.
     */
    stepBack(mode = "over", count = 1) {
        if (!["into", "over", "out"].includes(mode)) throw new Error('mode is "into", "over" or "out"');
        let left = Math.max(1, count | 0);
        let steps = 0;
        let ref = null;
        let lastFound;
        const accept = {
            into: (seg, j) => seg.irq[j] <= ref.irq,
            over: (seg, j) => seg.irq[j] <= ref.irq && seg.depth[j] <= ref.depth,
            out: (seg, j) => seg.irq[j] <= ref.irq && seg.depth[j] < ref.depth,
        }[mode];
        const { moved } = this._goBack(`Step back ${mode}`, (seg, oldest) => {
            const last = seg.cycles.length - 1;
            // Depths count from each stretch's start; carry the reference back across.
            ref = ref === null ? { depth: seg.depth[last], irq: seg.irq[last] } : { depth: ref.depth + seg.depth[last], irq: ref.irq + seg.irq[last] };
            for (let j = last - 1; j >= 0; j--) {
                if (!accept(seg, j)) continue;
                steps++;
                lastFound = seg.cycles[j];
                ref = { depth: seg.depth[j], irq: seg.irq[j] };
                if (--left === 0) return lastFound;
            }
            return oldest ? lastFound : undefined;
        });
        const result = { moved, steps };
        if (steps < count) result.note = steps === 0 ? (mode === "out" ? "No call to go back out of in the history" : "At the start of the history") : `Reached the start of the history after ${steps}`;
        this._stopped({ reason: "step", description: `Step back ${mode}` });
        return result;
    }

    /** Back to the last breakpoint hit or watchpoint access before here, or the start of the history. */
    reverseContinue() {
        let hit;
        const { moved } = this._goBack(
            "Reverse continue",
            (seg, oldest) => {
                for (let j = seg.hits.length - 1; j >= 0; j--) {
                    const h = seg.hits[j];
                    if (h.cycles < seg.end) {
                        hit = h;
                        return h.cycles;
                    }
                }
                return oldest ? this._history.start : undefined;
            },
            { watches: this._watchpoints.size > 0 },
        );
        if (hit?.kind === "breakpoint") {
            this._stopped({ reason: "breakpoint", description: `Breakpoint at ${this.describeAddress(hit.pc)} (going back)`, breakpointIds: hit.bps.map((b) => b.id) });
        } else if (hit) {
            this._stopped(this._watchStop(hit));
        } else {
            this._stopped({ reason: "step", description: "Back at the start of the history" });
        }
        const result = { moved, hit: !!hit };
        if (!hit) result.note = "No breakpoint or watchpoint was hit in the history: this is its start";
        return result;
    }

    /** Back to the last time execution reached an address (in a bank, for &8000-&BFFF). */
    runBackTo(address, { bank } = {}) {
        address &= 0xffff;
        if (!isBanked(address)) bank = undefined;
        const { moved, found } = this._goBack(`Run back to ${hex(address)}`, (seg) => {
            for (let j = seg.cycles.length - 2; j >= 0; j--) if (seg.pc[j] === address && (bank === undefined || seg.bank[j] === bank)) return seg.cycles[j];
            return undefined;
        }, { banks: bank !== undefined });
        this._stopped({ reason: "step", description: found !== undefined ? `Back at ${this.describeAddress(address)}` : "Run back" });
        return found !== undefined ? { moved } : { moved, note: `${this.describeAddress(address, bank)} was not reached in the history` };
    }

    /** Back to the instruction that last wrote an address, before it runs. */
    runBackToWrite(address) {
        address &= 0xffff;
        let hit;
        const { moved } = this._goBack(
            `Run back to the write of ${hex(address)}`,
            (seg) => {
                for (let j = seg.hits.length - 1; j >= 0; j--) {
                    if (seg.hits[j].kind === "write" && seg.hits[j].cycles < seg.end) {
                        hit = seg.hits[j];
                        return hit.cycles;
                    }
                }
                return undefined;
            },
            { writes: address },
        );
        if (hit) {
            this._stopped({ reason: "step", description: `Before the write of ${hex(hit.new, 2)} to ${this.describeAddress(address)}` });
            return { moved, write: { address: hit.address, old: hit.old, new: hit.new, by: hit.by } };
        }
        this._stopped({ reason: "step", description: "Run back" });
        return { moved, note: `Nothing wrote ${this.describeAddress(address)} in the history` };
    }

    /** From the past, replay to the newest instant. */
    returnToLive() {
        if (this.running) this.pause(undefined, { internal: true });
        const moved = this._history.inPast;
        if (moved) this._history.seek(this._history.head);
        this._checkFrame();
        this._stopped({ reason: "step", description: "Back to the present" });
        return { moved };
    }

    // -----------------------------------------------------------------------
    // Machine control and loading

    /** A hard or soft reset; a different model (or second processor) builds a new machine. */
    async reset({ hard = true, model, tube } = {}) {
        if (this.typing) this.machine.typist.cancel();
        if ((model && findModel(model)?.name !== this.model.name) || (tube !== undefined && tube !== this.tube)) {
            await this._create(model ?? this.modelName, { tube: tube ?? this.tube });
        } else {
            this.session.reset(hard);
            // The history starts again at a power-on; a BREAK is a step in it.
            if (hard) this._history.reset();
            else this._mutated();
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

    /**
     * Unpaced run until `count` more frames have been painted, stopping on the
     * paint itself (the first instruction after it): a frame is 40000 cycles
     * interlaced and 39936 not, so a run measured in cycles drifts against the
     * picture. Resolves to null, or the stop if something else came first.
     */
    async runFrames(count, { limitSeconds } = {}) {
        const target = this.session.frameCount + Math.max(1, count | 0);
        this._startStep({
            kind: `Run ${count} frame${count === 1 ? "" : "s"}`,
            done: () => this.session.frameCount >= target,
            interrupts: true,
            internal: true,
            // A machine that has stopped painting would otherwise run forever.
            limitSeconds: limitSeconds ?? Math.max(1, count * 0.1),
        });
        const stop = await this.waitForStop();
        return stop.reason === "step" && !stop.timedOut ? null : stop;
    }

    /** Unpaced run for a number of CPU cycles, to within the instruction that finishes it. */
    async runCycles(cycles) {
        const until = this.elapsedCycles + Math.max(1, cycles);
        this._startStep({ kind: `Run ${cycles} cycles`, done: () => this.elapsedCycles >= until, interrupts: true, internal: true, limitSeconds: cycles / this.model.cyclesPerSecond + 1 });
        const stop = await this.waitForStop();
        return stop.reason === "step" && !stop.timedOut ? null : stop;
    }

    /**
     * Unpaced run until the OS is waiting for a key: back at the BASIC or *
     * prompt, or a program's INPUT or GET. Anything still being typed is
     * delivered first. null on arrival, else the stop (timedOut if it never came).
     */
    async runUntilPrompt(timeoutSeconds = 60) {
        if (this.typing) {
            const stop = await this.runUntilTyped(timeoutSeconds);
            if (stop) return stop;
        }
        return this.runUntil(this.model.idleAddress, timeoutSeconds);
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
        this._mutated();
    }

    /**
     * A disc from anywhere jsbeeb can find one: a file path, a file: or
     * http(s): URL, "sth:Acornsoft/Elite.zip" (Stairway to Hell), "hfe:<path>"
     * (the BBC disc archive) or "bitshifters:<path>". Zips are opened and the
     * disc inside used. Returns { name, ignored }.
     */
    async loadDiscRef(ref, drive = 0) {
        const isRef = /^(sth|hfe|bitshifters|https?|file):/i.test(ref);
        const result = await this.session.loadDiscImage(isRef ? ref : pathToFileURL(path.resolve(ref)).href, drive);
        if (drive === 0) this.programPath = ref;
        this._mutated();
        return result;
    }

    async loadTape(file) {
        await this.session.loadTape(file);
        this.programPath = file;
        this._mutated();
    }

    /** What is paged: romsel (the sideways bank at &8000), and on a Master acccon. */
    setPaging({ bank, acccon } = {}) {
        if (bank !== undefined) {
            if (!Number.isInteger(bank) || bank < 0 || bank > 15) throw new Error("bank is a sideways bank, 0-15");
            this.cpu.romSelect((this.cpu.romsel & 0xf0) | bank);
        }
        if (acccon !== undefined) {
            if (!this.model.isMaster) throw new Error("Only a Master has ACCCON");
            this.cpu.writeAcccon(acccon & 0xff);
        }
        this._mutated();
        return this.paging();
    }

    /**
     * Put a sideways ROM (or RAM) image into a bank. The MOS looks for
     * sideways ROMs at a reset, so a ROM is not seen until one.
     */
    loadSidewaysRom(bank, data) {
        if (!Number.isInteger(bank) || bank < 0 || bank > 15) throw new Error("bank is a sideways bank, 0-15");
        if (data.length > 16384) throw new Error(`A sideways ROM is at most 16K; this is ${data.length} bytes`);
        this.machine.loadSidewaysRam(bank, data);
        this._mutated();
    }

    /** The cassette recorder: "play", "stop", "rewind", "eject", or "status". */
    tapeControl(action = "status") {
        const t = this.cpu.tapeInterface;
        switch (action) {
            case "play":
                t.pressPlay();
                break;
            case "stop":
                t.pressStop?.();
                break;
            case "rewind":
                if (t.rewindTape) t.rewindTape();
                else t.tape?.rewind();
                break;
            case "eject":
                t.pressStop?.();
                t.setTape(null);
                break;
            case "status":
                break;
            default:
                throw new Error('action is "play", "stop", "rewind", "eject" or "status"');
        }
        if (action !== "status") this._mutated();
        const tape = t.tape;
        return {
            tape: tape ? (tape.name ? path.basename(tape.name) : "inserted") : null,
            position: tape && typeof tape.position === "number" ? Math.round(tape.position * 1000) / 1000 : undefined,
            play_pressed: !!t.playPressed,
            motor_on: !!t.motorOn,
            moving: !!t.tapeRunning,
        };
    }

    async loadBasic(source) {
        await this.session.loadBasic(source);
        this._mutated();
    }

    loadBinary(file, address) {
        const data = fs.readFileSync(file);
        if (address + data.length > 0x10000) throw new Error(`${path.basename(file)} is ${data.length} bytes: too long to load at ${hex(address)}`);
        this.writeMemory(address, data);
        this.programPath = file;
        return data.length;
    }

    /** Put back a state from session.snapshot(); breakpoints and the frame counter carry on. */
    restore(state) {
        this.session.restore(state);
        this._history.reset();
        this.emit("reset");
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
        this._history.reset();
        this.emit("reset");
        return snap.model;
    }

    /** `bank`: the sideways bank the program's code at &8000-&BFFF is in, for a sideways ROM. */
    loadDebugInfo(files, { source, bank } = {}) {
        const kinds = [];
        for (const f of [].concat(files)) kinds.push(this.debugInfo.loadFile(f, { source, bank }));
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
            in_past: this._history.inPast,
            behind_cycles: this._history.behindCycles,
        };
    }

    dispose() {
        this._trace?.close();
        this._video?.stop();
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
