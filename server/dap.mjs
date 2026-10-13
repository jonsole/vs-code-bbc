// The Debug Adapter Protocol, served over TCP: VS Code (or any DAP client)
// connects, and each connection is a DapSession on the one Engine.
//
// The machine outlives sessions. Ending a session takes its breakpoints and
// watchpoints away and leaves the machine running, so an MCP client using the
// same machine carries on undisturbed.

import net from "node:net";
import path from "node:path";
import { hex, Engine } from "./engine.mjs";
import { loadProgram, programKind } from "./program.mjs";
import { parseNumber } from "./expr.mjs";

const ThreadId = 1;
const Ref = { registers: 1, flags: 2, stack: 3, symbols: 4 };
const FlagNames = [
    ["N", 0x80, "negative"],
    ["V", 0x40, "overflow"],
    ["D", 0x08, "decimal"],
    ["I", 0x04, "interrupt disable"],
    ["Z", 0x02, "zero"],
    ["C", 0x01, "carry"],
];

let nextSessionId = 1;

export function startDapServer(engine, { port, host = "127.0.0.1", log = () => {} }) {
    const server = net.createServer((socket) => {
        const session = new DapSession(engine, socket, log);
        log(`DAP: client ${session.id} connected`);
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server));
    });
}

function memRef(address) {
    return "0x" + (address & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

function parseMemRef(ref) {
    const n = parseNumber(ref);
    if (n === undefined) throw new Error(`Bad memory reference "${ref}"`);
    return n;
}

function formatValue(v, bytes = v > 0xff || v < 0 ? 2 : 1) {
    const u = bytes === 1 ? v & 0xff : v & 0xffff;
    return `${hex(u, bytes * 2)} (${u})`;
}

export class DapSession {
    constructor(engine, socket, log) {
        this.engine = engine;
        this.socket = socket;
        this.log = log;
        this.id = nextSessionId++;
        this.owner = `dap${this.id}`;
        this.seq = 1;
        this.buffer = Buffer.alloc(0);
        this.sourceBreakpoints = new Map(); // path -> [{ line, condition, hitCondition, logMessage }]
        this.configured = null;
        this.launchArgs = null;
        this.closed = false;

        this._onStopped = (stop) => this._sendStopped(stop);
        this._onContinued = (info) => {
            if (!info?.internal) this.event("continued", { threadId: ThreadId, allThreadsContinued: true });
        };
        this._onOutput = (entry) => this.event("output", { category: "console", output: entry.text + "\n" });
        this._onDebugInfo = () => this._reresolveSourceBreakpoints();
        engine.on("stopped", this._onStopped);
        engine.on("continued", this._onContinued);
        engine.on("output", this._onOutput);
        engine.on("debugInfo", this._onDebugInfo);

        engine.debuggers++;
        socket.on("data", (d) => this._onData(d));
        socket.on("close", () => this._close());
        socket.on("error", () => this._close());
    }

    // -- framing ----------------------------------------------------------

    _onData(data) {
        this.buffer = Buffer.concat([this.buffer, data]);
        for (;;) {
            const headerEnd = this.buffer.indexOf("\r\n\r\n");
            if (headerEnd < 0) return;
            const header = this.buffer.subarray(0, headerEnd).toString("ascii");
            const m = /Content-Length:\s*(\d+)/i.exec(header);
            if (!m) {
                this.buffer = this.buffer.subarray(headerEnd + 4);
                continue;
            }
            const length = Number(m[1]);
            if (this.buffer.length < headerEnd + 4 + length) return;
            const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
            this.buffer = this.buffer.subarray(headerEnd + 4 + length);
            let msg;
            try {
                msg = JSON.parse(body);
            } catch {
                continue;
            }
            if (msg.type === "request") this._dispatch(msg);
        }
    }

    _write(msg) {
        if (this.closed) return;
        const body = Buffer.from(JSON.stringify(msg), "utf8");
        this.socket.write(`Content-Length: ${body.length}\r\n\r\n`);
        this.socket.write(body);
    }

    event(event, body) {
        this._write({ seq: this.seq++, type: "event", event, body });
    }

    _respond(req, body, error) {
        const msg = { seq: this.seq++, type: "response", request_seq: req.seq, command: req.command, success: !error };
        if (error) {
            msg.message = error;
            msg.body = { error: { id: 1, format: error, showUser: true } };
        } else if (body !== undefined) msg.body = body;
        this._write(msg);
    }

    async _dispatch(req) {
        if (Moving.has(req.command)) this.engine.driver = "dap";
        const handler = this[`on_${req.command}`];
        if (!handler) return this._respond(req, undefined, `Unsupported request: ${req.command}`);
        try {
            const body = await handler.call(this, req.arguments ?? {}, req);
            if (body !== NoResponse) this._respond(req, body);
        } catch (e) {
            this.log(`DAP ${req.command}: ${e.stack ?? e}`);
            this._respond(req, undefined, e.message ?? String(e));
        }
    }

    _close() {
        if (this.closed) return;
        this.closed = true;
        this.engine.debuggers--;
        const e = this.engine;
        e.off("stopped", this._onStopped);
        e.off("continued", this._onContinued);
        e.off("output", this._onOutput);
        e.off("debugInfo", this._onDebugInfo);
        this._dropBreakpoints();
        this.log(`DAP: client ${this.id} gone`);
    }

    _dropBreakpoints() {
        for (const owner of this._owners()) this.engine.setBreakpoints(owner, []);
        this.engine.clearWatchpoints(this.owner);
    }

    _owners() {
        return this.engine
            .breakpoints()
            .map((b) => b.owner)
            .filter((o, i, all) => o.startsWith(this.owner + ":") && all.indexOf(o) === i);
    }

    _sendStopped(stop) {
        if (stop.internal) return;
        const body = {
            reason: stop.reason,
            description: stop.description,
            threadId: ThreadId,
            allThreadsStopped: true,
            // A stop an MCP client caused is shown without taking the editor
            // over: the person at it may be reading something else.
            preserveFocusHint: stop.driver === "mcp",
        };
        if (stop.breakpointIds?.length) body.hitBreakpointIds = stop.breakpointIds;
        if (stop.reason === "data breakpoint" || stop.reason === "breakpoint") body.text = stop.description;
        this.event("stopped", body);
    }

    // -- lifecycle ----------------------------------------------------------

    on_initialize(args) {
        this.clientLinesStartAt1 = args.linesStartAt1 !== false;
        this.supportsMemoryEvent = !!args.supportsMemoryEvent;
        this.configured = new Promise((resolve) => (this._configurationDone = resolve));
        return {
            supportsConfigurationDoneRequest: true,
            supportsConditionalBreakpoints: true,
            supportsHitConditionalBreakpoints: true,
            supportsLogPoints: true,
            supportsFunctionBreakpoints: true,
            supportsInstructionBreakpoints: true,
            supportsDataBreakpoints: true,
            supportsDataBreakpointBytes: true,
            supportsReadMemoryRequest: true,
            supportsWriteMemoryRequest: true,
            supportsDisassembleRequest: true,
            supportsSetVariable: true,
            supportsEvaluateForHovers: true,
            supportsSteppingGranularity: false,
            supportsTerminateRequest: true,
            supportsRestartRequest: true,
            supportsValueFormattingOptions: false,
            supportsRunToLocation: false,
            supportsStepBack: true,
            breakpointModes: [],
        };
    }

    on_configurationDone() {
        this._configurationDone?.();
    }

    /**
     * launch: reset the machine and load `program` (see program.mjs for the
     * arguments). Breakpoints arrive between the `initialized` event and
     * configurationDone, and the program starts only after that, so a
     * breakpoint on its first instruction is hit.
     */
    async on_launch(args, req) {
        this.launchArgs = args;
        this._preloadDebugInfo(args);
        this.event("initialized");
        this._respond(req);
        await this.configured;
        await this._start(args);
        return NoResponse;
    }

    async on_attach(args) {
        this.launchArgs = null;
        if (args.debugInfo?.length) this._preloadDebugInfo(args, { keepExisting: true });
        this.event("initialized");
        await this.configured;
        if (args.stopOnAttach !== false || !this.engine.running) {
            if (!this.engine.pause("Attached")) this._sendStopped({ reason: "entry", description: "Attached" });
        }
    }

    _preloadDebugInfo(args, { keepExisting = false } = {}) {
        const files = (args.debugInfo ?? []).map((f) => path.resolve(args.cwd ?? ".", f));
        args.debugInfo = files;
        if (args.source) args.source = path.resolve(args.cwd ?? ".", args.source);
        if (!keepExisting) this.engine.clearDebugInfo();
        if (files.length) this.engine.loadDebugInfo(files, { source: args.source, bank: args.romBank });
    }

    async _start(args) {
        // A disc reference (sth:..., https:...) is not a path.
        const program = !args.program ? undefined : /^(sth|hfe|bitshifters|https?|file):/i.test(args.program) ? args.program : path.resolve(args.cwd ?? ".", args.program);
        let stopAt = args.stopAt;
        const kind = program ? programKind(program) : "none";
        if (args.stopOnEntry && stopAt === undefined && kind === "binary") stopAt = args.execAddress ?? args.loadAddress;
        try {
            const result = await loadProgram(this.engine, { ...args, program, stopAt });
            this.event("output", { category: "console", output: `${result.description}\n` });
            if (result.stop) return; // stopped already, and said so
            if (args.stopOnEntry) this.engine.emitStopAt("Entry");
            else this.engine.resume();
        } catch (e) {
            this.event("output", { category: "stderr", output: `Launch failed: ${e.message}\n` });
            this.event("terminated");
        }
    }

    async on_restart(args, req) {
        const launch = args.arguments ?? this.launchArgs;
        this._respond(req);
        if (launch) {
            this.launchArgs = launch;
            this._preloadDebugInfo(launch);
            await this._start(launch);
        } else {
            await this.engine.reset({ hard: true });
            this.engine.resume();
        }
        return NoResponse;
    }

    on_disconnect() {
        this._dropBreakpoints();
        if (!this.engine.running) this.engine.resume();
    }

    on_terminate() {
        this._dropBreakpoints();
        if (!this.engine.running) this.engine.resume();
        this.event("terminated");
    }

    // -- breakpoints ---------------------------------------------------------

    on_setBreakpoints(args) {
        const file = args.source?.path;
        // Each keeps one id for its life, so a "changed" event after the debug info reloads refers to it.
        const specs = (args.breakpoints ?? (args.lines ?? []).map((line) => ({ line }))).map((s) => ({ ...s, id: Engine.newBreakpointId() }));
        if (!file) return { breakpoints: specs.map(() => ({ verified: false, message: "No source path" })) };
        this.sourceBreakpoints.set(file, specs);
        return { breakpoints: this._applySource(file) };
    }

    _applySource(file) {
        const specs = this.sourceBreakpoints.get(file) ?? [];
        const info = this.engine.debugInfo;
        const resolved = specs.map((s) => ({ spec: s, at: info.addressForLine(file, s.line) }));
        const set = this.engine.setBreakpoints(
            `${this.owner}:src:${file}`,
            resolved.filter((r) => r.at).map((r) => ({ ...r.spec, address: r.at.address, bank: r.at.bank, kind: "source" })),
        );
        let i = 0;
        return resolved.map((r) => {
            if (!r.at) {
                return {
                    id: r.spec.id,
                    verified: false,
                    line: r.spec.line,
                    message: info.hasFile(file) ? "No code on or after this line" : "No debug info for this file: give the listing or .dbg in debugInfo",
                };
            }
            const bp = set[i++];
            return { id: bp.id, verified: bp.verified, line: r.at.line, message: bp.message, instructionReference: memRef(bp.address) };
        });
    }

    _reresolveSourceBreakpoints() {
        for (const file of this.sourceBreakpoints.keys()) {
            for (const bp of this._applySource(file)) {
                this.event("breakpoint", { reason: "changed", breakpoint: { ...bp, source: { path: file } } });
            }
        }
    }

    on_setFunctionBreakpoints(args) {
        const specs = [];
        const results = (args.breakpoints ?? []).map((b) => {
            try {
                const address = this.engine.resolveAddress(b.name);
                specs.push({ ...b, address, kind: "function" });
                return { ok: true };
            } catch (e) {
                return { ok: false, message: e.message };
            }
        });
        const set = this.engine.setBreakpoints(`${this.owner}:fn`, specs);
        let i = 0;
        return {
            breakpoints: results.map((r) => {
                if (!r.ok) return { verified: false, message: r.message };
                const bp = set[i++];
                return { id: bp.id, verified: bp.verified, message: bp.message ?? this.engine.describeAddress(bp.address), instructionReference: memRef(bp.address) };
            }),
        };
    }

    on_setInstructionBreakpoints(args) {
        const specs = (args.breakpoints ?? []).map((b) => ({
            ...b,
            address: (parseMemRef(b.instructionReference) + (b.offset ?? 0)) & 0xffff,
            kind: "instruction",
        }));
        const set = this.engine.setBreakpoints(`${this.owner}:insn`, specs);
        return { breakpoints: set.map((bp) => ({ id: bp.id, verified: bp.verified, message: bp.message, instructionReference: memRef(bp.address) })) };
    }

    on_dataBreakpointInfo(args) {
        let address;
        let length = args.bytes ?? 1;
        try {
            if (args.asAddress) address = parseMemRef(args.name);
            else if (args.variablesReference === Ref.symbols) address = this.engine.debugInfo.lookup(args.name);
            else if (args.variablesReference === Ref.registers || args.variablesReference === Ref.flags) address = undefined;
            else address = this.engine.resolveAddress(args.name);
        } catch {
            address = undefined;
        }
        if (address === undefined) return { dataId: null, description: "Only memory can be watched" };
        return {
            dataId: `${address}:${length}`,
            description: `${length} byte${length === 1 ? "" : "s"} at ${this.engine.describeAddress(address)}`,
            accessTypes: ["read", "write", "readWrite"],
            canPersist: true,
        };
    }

    on_setDataBreakpoints(args) {
        this.engine.clearWatchpoints(this.owner);
        const breakpoints = (args.breakpoints ?? []).map((b) => {
            const [address, length] = b.dataId.split(":").map(Number);
            const access = b.accessType === "read" ? "read" : b.accessType === "readWrite" ? "readwrite" : "write";
            try {
                const w = this.engine.addWatchpoint({ owner: this.owner, address, length, access, condition: b.condition });
                return { id: w.id, verified: true };
            } catch (e) {
                return { verified: false, message: e.message };
            }
        });
        return { breakpoints };
    }

    on_setExceptionBreakpoints() {
        return { breakpoints: [] };
    }

    // -- execution -----------------------------------------------------------

    on_threads() {
        return { threads: [{ id: ThreadId, name: `${this.engine.model.name}` }] };
    }

    on_continue() {
        this.engine.resume();
        return { allThreadsContinued: true };
    }

    on_pause() {
        if (!this.engine.pause()) this._sendStopped({ reason: "pause", description: "Paused" });
    }

    on_next() {
        this.engine.stepOver();
    }

    on_stepIn() {
        this.engine.stepInstruction();
    }

    on_stepOut() {
        this.engine.stepOut();
    }

    // Going back is answered first; the stop where it lands follows as a
    // stopped event, as a step's does.
    on_stepBack() {
        this._goBack(() => this.engine.stepBack("over", 1));
    }

    on_reverseContinue() {
        this._goBack(() => this.engine.reverseContinue());
    }

    _goBack(fn) {
        setImmediate(() => {
            try {
                fn();
            } catch (e) {
                this.event("output", { category: "stderr", output: `${e.message}\n` });
                this._sendStopped({ reason: "step", description: e.message });
            }
        });
    }

    // -- state ---------------------------------------------------------------

    _source(file) {
        return { name: path.basename(file), path: file };
    }

    on_stackTrace(args) {
        const e = this.engine;
        const frames = e.callStack().map((f, i) => {
            const at = e.debugInfo.lineFor(f.pc, e.bankAt(f.pc));
            const name = f.kind === "current" ? e.describeAddress(f.pc) : `${e.describeAddress(f.pc)} JSR ${e.symbolFor(f.callee) ?? hex(f.callee)}`;
            const frame = {
                id: i,
                name,
                line: at ? at.line : 0,
                column: at ? 1 : 0,
                instructionPointerReference: memRef(f.pc),
            };
            if (at) frame.source = this._source(at.file);
            else frame.presentationHint = "subtle";
            return frame;
        });
        const start = args.startFrame ?? 0;
        const count = args.levels || frames.length;
        return { stackFrames: frames.slice(start, start + count), totalFrames: frames.length };
    }

    on_scopes() {
        const scopes = [
            { name: "Registers", variablesReference: Ref.registers, expensive: false, presentationHint: "registers" },
            { name: "Stack", variablesReference: Ref.stack, expensive: false },
        ];
        if (this.engine.debugInfo.symbols.size) scopes.push({ name: "Symbols", variablesReference: Ref.symbols, expensive: true });
        return { scopes };
    }

    on_variables(args) {
        const e = this.engine;
        const r = e.registers();
        switch (args.variablesReference) {
            case Ref.registers:
                return {
                    variables: [
                        { name: "PC", value: e.describeAddress(r.pc), variablesReference: 0, memoryReference: memRef(r.pc) },
                        { name: "A", value: formatValue(r.a, 1), variablesReference: 0 },
                        { name: "X", value: formatValue(r.x, 1), variablesReference: 0 },
                        { name: "Y", value: formatValue(r.y, 1), variablesReference: 0 },
                        { name: "S", value: formatValue(r.s, 1), variablesReference: 0, memoryReference: memRef(0x100 + r.s) },
                        { name: "P", value: `${hex(r.p, 2)} ${e.flagsString(r.p)}`, variablesReference: Ref.flags },
                    ],
                };
            case Ref.flags:
                return {
                    variables: FlagNames.map(([n, bit, what]) => ({
                        name: n,
                        value: r.p & bit ? "1" : "0",
                        type: what,
                        variablesReference: 0,
                    })),
                };
            case Ref.stack: {
                const out = [];
                for (let sp = r.s + 1; sp <= 0xff && out.length < 64; sp++) {
                    const v = e.peek(0x100 + sp);
                    out.push({ name: hex(0x100 + sp), value: formatValue(v, 1), variablesReference: 0, memoryReference: memRef(0x100 + sp) });
                }
                return { variables: out };
            }
            case Ref.symbols: {
                const out = [...e.debugInfo.symbols]
                    .sort((a, b) => a[1] - b[1])
                    .map(([name, addr]) => ({
                        name,
                        value: `${hex(addr)}: ${hex(e.peek(addr), 2)} ${hex(e.peek(addr) | (e.peek(addr + 1) << 8))}`,
                        variablesReference: 0,
                        memoryReference: memRef(addr),
                        evaluateName: name,
                    }));
                return { variables: out };
            }
        }
        return { variables: [] };
    }

    on_setVariable(args) {
        const e = this.engine;
        const value = e.evaluate(args.value);
        if (args.variablesReference === Ref.registers || args.variablesReference === Ref.flags) {
            e.setRegister(args.name, value);
            const r = e.registers();
            const n = args.name.toLowerCase();
            const now = n === "pc" ? e.describeAddress(r.pc) : n === "p" ? `${hex(r.p, 2)} ${e.flagsString(r.p)}` : n in r ? formatValue(r[n], 1) : value ? "1" : "0";
            this.event("invalidated", { areas: ["variables"] });
            return { value: now };
        }
        if (args.variablesReference === Ref.stack) {
            const addr = parseNumber(args.name);
            e.writeMemory(addr, [value & 0xff]);
            return { value: formatValue(value & 0xff, 1) };
        }
        if (args.variablesReference === Ref.symbols) {
            const addr = e.debugInfo.lookup(args.name);
            e.writeMemory(addr, [value & 0xff]);
            return { value: `${hex(addr)}: ${hex(value & 0xff, 2)}` };
        }
        throw new Error("That can't be changed");
    }

    on_evaluate(args) {
        const e = this.engine;
        const text = (args.expression ?? "").trim();
        if (args.context === "repl" && text.startsWith(">")) {
            // `>` types the rest at the BBC's keyboard: `>*CAT`, `>RUN`
            e.type(text.slice(1));
            if (!e.running) e.resume();
            return { result: `Typed ${JSON.stringify(text.slice(1))}`, variablesReference: 0 };
        }
        if (args.context === "hover") {
            // Hovering a mnemonic or a register name in the source: only symbols and registers.
            if (!/^[A-Za-z_][\w]*$/.test(text)) throw new Error("Not an expression");
        }
        const v = e.evaluate(text);
        const result = v >= 0 && v <= 0xffff ? `${formatValue(v)}${v > 0xff || e.debugInfo.lookup(text) !== undefined ? `  [${hex(e.peek(v), 2)}]` : ""}` : String(v);
        return { result, variablesReference: 0, memoryReference: v >= 0 && v <= 0xffff ? memRef(v) : undefined };
    }

    on_readMemory(args) {
        const start = parseMemRef(args.memoryReference) + (args.offset ?? 0);
        if (start < 0 || start > 0xffff) return { address: memRef(start & 0xffff), unreadableBytes: args.count, data: "" };
        const count = Math.max(0, Math.min(args.count ?? 0, 0x10000 - start));
        const bytes = this.engine.readMemory(start, count);
        return {
            address: memRef(start),
            data: Buffer.from(bytes).toString("base64"),
            unreadableBytes: (args.count ?? 0) - count,
        };
    }

    on_writeMemory(args) {
        const start = parseMemRef(args.memoryReference) + (args.offset ?? 0);
        const data = Buffer.from(args.data ?? "", "base64");
        const count = Math.min(data.length, 0x10000 - start);
        this.engine.writeMemory(start, data.subarray(0, count));
        if (this.supportsMemoryEvent) this.event("memory", { memoryReference: memRef(start), offset: 0, count });
        this.event("invalidated", { areas: ["variables"] });
        return { bytesWritten: count };
    }

    on_disassemble(args) {
        const e = this.engine;
        let address = (parseMemRef(args.memoryReference) + (args.offset ?? 0)) & 0xffff;
        let skip = args.instructionOffset ?? 0;
        // Walk back for a negative offset; jsbeeb's guess at the previous instruction resynchronises quickly.
        while (skip < 0) {
            address = e.previousInstruction(address);
            skip++;
        }
        const list = e.disassembleRange(address, skip + args.instructionCount).slice(skip);
        let lastFile;
        return {
            instructions: list.map((d) => {
                const at = e.debugInfo.lineFor(d.address, e.bankAt(d.address));
                const insn = {
                    address: memRef(d.address),
                    instructionBytes: d.bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" "),
                    instruction: d.text,
                };
                const sym = e.symbolFor(d.address);
                if (sym) insn.symbol = sym;
                if (at) {
                    insn.line = at.line;
                    if (at.file !== lastFile) insn.location = this._source(at.file);
                    lastFile = at.file;
                }
                return insn;
            }),
        };
    }

    on_source() {
        throw new Error("No source: the disassembly view shows this code");
    }

    on_loadedSources() {
        return { sources: [...new Set([...this.engine.debugInfo.lines.values()].map((l) => l.file))].map((f) => this._source(f)) };
    }
}

const NoResponse = Symbol("NoResponse");
// The requests that set the machine moving: their stops are the debugger's own.
const Moving = new Set(["launch", "attach", "restart", "continue", "next", "stepIn", "stepOut", "pause", "stepBack", "reverseContinue"]);
