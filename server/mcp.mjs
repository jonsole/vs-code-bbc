// MCP (Model Context Protocol) over streamable HTTP, at POST /mcp: the same
// machine VS Code is debugging, for an AI agent to drive. Each request is
// answered with a single JSON response; the server keeps no per-client state,
// so any client may connect at any time.
//
// The tools follow the ZX Spectrum emulator's where the two machines agree
// (load, run, pause, step, breakpoints, watchpoints, memory, registers,
// screen, keys), so an agent that knows one knows the other.

import path from "node:path";
import { hex, resolveKeyCode } from "./engine.mjs";
import { loadProgram } from "./program.mjs";

const ProtocolVersions = ["2025-06-18", "2025-03-26", "2024-11-05"];
const McpOwner = "mcp";

const addressParam = {
    type: ["string", "integer"],
    description: 'An address: &1900, $1900, 0x1900, 6400, a symbol, or an expression such as "table+2"',
};

function hexBytes(bytes) {
    return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

function dump(engine, start, bytes) {
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
        const row = bytes.subarray(i, i + 16);
        const ascii = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
        lines.push(`${hex(start + i)}  ${hexBytes(row).padEnd(47)}  ${ascii}`);
    }
    return lines.join("\n");
}

function parseHexData(text) {
    const clean = String(text).replace(/[\s,]/g, "").replace(/^0x/i, "");
    if (!/^([0-9a-f]{2})*$/i.test(clean)) throw new Error("data must be hex bytes, e.g. \"A9 00 60\"");
    return Buffer.from(clean, "hex");
}

export function makeTools(engine, serverInfo) {
    const addr = (v) => engine.resolveAddress(v);
    const stopSummary = (stop) => (stop ? { reason: stop.reason, description: stop.description, at: engine.describeAddress(engine.cpu.pc) } : null);
    const wait = async (ms) => (ms > 0 ? stopSummary(await engine.waitForStop(ms)) : null);

    /** name -> { description, inputSchema, run(args) -> result | {content} } */
    const tools = {
        server_info: {
            description: "Which emulator this is: its version, the emulated model, the ports it serves DAP, MCP and the screen on, and the program last loaded.",
            run: () => serverInfo(),
        },
        get_state: {
            description: "The machine at a glance: running or stopped and why, registers and flags, the instruction at PC, breakpoints, watchpoints, a guess at the call stack, and cycles and frames run.",
            run: () => engine.state(),
        },
        load_program: {
            description:
                "Reset the machine and load a program from a file on this computer, then start it. .ssd/.dsd discs boot with SHIFT-BREAK; .uef tapes are CHAINed; .bas files are BBC BASIC source, tokenised and RUN; anything else is a raw binary that needs load_address (and exec_address if it is not entered at the start). The machine is left running unless stop_at is given or a breakpoint is hit.",
            inputSchema: {
                type: "object",
                properties: {
                    path: { type: "string", description: "The file to load" },
                    model: { type: "string", description: 'Machine model: "B-DFS1.2" (default BBC B), "Master", "B1770", "MasterADFS", ...' },
                    load_address: addressParam,
                    exec_address: addressParam,
                    run: { type: "string", description: 'What to type to start it instead of the default, e.g. "*RUN GAME" or "CHAIN \\"MENU\\""' },
                    boot: { type: "boolean", description: "Start the program (default true); false loads it and stops at the BASIC prompt" },
                    debug_info: { type: "array", items: { type: "string" }, description: "Symbol files: BeebAsm -labels output, a BeebAsm -v listing (with source), a ca65 .dbg, or VICE labels" },
                    source: { type: "string", description: "The main source file a BeebAsm listing came from" },
                    stop_at: addressParam,
                },
                required: ["path"],
            },
            run: async (a) => {
                const r = await loadProgram(engine, {
                    program: a.path,
                    model: a.model,
                    loadAddress: a.load_address,
                    execAddress: a.exec_address,
                    run: a.run,
                    boot: a.boot,
                    debugInfo: a.debug_info?.map((f) => path.resolve(f)),
                    source: a.source && path.resolve(a.source),
                    stopAt: a.stop_at,
                });
                if (!r.stop) engine.resume();
                return { loaded: r.description, kind: r.kind, stopped: stopSummary(r.stop), running: engine.running };
            },
        },
        reset: {
            description: "Reset the machine: a power-on (hard) reset by default, or BREAK (hard: false). With model, switch to that model first. Leaves it running.",
            inputSchema: {
                type: "object",
                properties: { hard: { type: "boolean" }, model: { type: "string" } },
            },
            run: async (a) => {
                engine.pause("Reset", { internal: true });
                await engine.reset({ hard: a.hard !== false, model: a.model });
                engine.resume();
                return { model: engine.model.name, running: true };
            },
        },
        run: {
            description: "Let the machine run (in real time) until a breakpoint, a watchpoint or pause. With wait_ms, wait that long for it to stop and say why.",
            inputSchema: { type: "object", properties: { wait_ms: { type: "integer" } } },
            run: async (a) => {
                engine.resume();
                const stop = await wait(a.wait_ms);
                return { running: engine.running, stopped: stop };
            },
        },
        run_for: {
            description: "Run for a span of emulated time as fast as possible, then stop: the quickest way to let a program get somewhere. Breakpoints still stop it early.",
            inputSchema: { type: "object", properties: { seconds: { type: "number", description: "Emulated seconds (default 1)" }, frames: { type: "integer", description: "Or a number of 50Hz frames" } } },
            run: async (a) => {
                const seconds = a.frames !== undefined ? a.frames / 50 : (a.seconds ?? 1);
                engine.pause("Run for", { internal: true });
                const stop = await engine.runFor(seconds);
                if (stop) return { completed: false, stopped: stopSummary(stop) };
                engine.emitStopAt(`Ran for ${seconds}s`, "pause");
                return { completed: true, at: engine.describeAddress(engine.cpu.pc) };
            },
        },
        pause: {
            description: "Stop a running machine.",
            run: () => {
                const was = engine.pause();
                return { paused: was, at: engine.describeAddress(engine.cpu.pc), instruction: engine.disassemble(engine.cpu.pc).text };
            },
        },
        step: {
            description: 'Execute instructions and stop. mode "into" (default) runs `count` instructions; "over" runs a JSR to its return; "out" runs to the RTS of the current subroutine. Interrupt handlers are run through as if one instruction.',
            inputSchema: {
                type: "object",
                properties: { count: { type: "integer" }, mode: { type: "string", enum: ["into", "over", "out"] } },
            },
            run: async (a) => {
                const mode = a.mode ?? "into";
                const count = Math.max(1, a.count ?? 1);
                let stop;
                for (let i = 0; i < (mode === "into" ? 1 : count); i++) {
                    if (mode === "over") engine.stepOver();
                    else if (mode === "out") engine.stepOut();
                    else engine.stepCount(count);
                    stop = await engine.waitForStop();
                    if (stop.reason !== "step") break;
                }
                const pc = engine.cpu.pc;
                return { stopped: stopSummary(stop), instruction: engine.disassemble(pc).text, registers: engine.state().registers };
            },
        },
        run_to: {
            description: "Run until PC reaches an address (a one-off breakpoint), as fast as possible, giving up after timeout_seconds of emulated time.",
            inputSchema: { type: "object", properties: { address: addressParam, timeout_seconds: { type: "number" } }, required: ["address"] },
            run: async (a) => {
                const target = addr(a.address);
                engine.runTo(target, { limitSeconds: a.timeout_seconds ?? 20 });
                const stop = await engine.waitForStop();
                return { arrived: engine.cpu.pc === target && stop.reason === "step" && !stop.timedOut, stopped: stopSummary(stop) };
            },
        },
        set_breakpoint: {
            description: "Stop when execution reaches an address. condition is an expression (e.g. \"A=&41\", \"?&70>3\", \"X<>0 AND C\"); log_message makes it a logpoint that records a message ({expressions} in braces) instead of stopping.",
            inputSchema: {
                type: "object",
                properties: { address: addressParam, condition: { type: "string" }, hit_count: { type: "string", description: 'e.g. "3" (from the 3rd hit), "==5", "%10"' }, log_message: { type: "string" } },
                required: ["address"],
            },
            run: (a) => {
                const existing = engine.breakpoints(McpOwner).map(({ address, condition, hitCondition, logMessage }) => ({ address, condition, hitCondition, logMessage }));
                const address = addr(a.address);
                const list = engine.setBreakpoints(McpOwner, [
                    ...existing.filter((b) => b.address !== address),
                    { address, condition: a.condition, hitCondition: a.hit_count, logMessage: a.log_message, kind: "instruction" },
                ]);
                const bp = list.find((b) => b.address === address);
                if (!bp.verified) throw new Error(bp.message);
                return { id: bp.id, address: engine.describeAddress(address), instruction: engine.disassemble(address).text };
            },
        },
        clear_breakpoint: {
            description: "Remove MCP's breakpoint at an address, or all of them if no address is given.",
            inputSchema: { type: "object", properties: { address: addressParam } },
            run: (a) => {
                const keep = a.address === undefined ? [] : engine.breakpoints(McpOwner).filter((b) => b.address !== addr(a.address));
                engine.setBreakpoints(McpOwner, keep);
                return { remaining: keep.map((b) => engine.describeAddress(b.address)) };
            },
        },
        list_breakpoints: {
            description: "Every breakpoint and logpoint set, by MCP or by VS Code, with hit counts.",
            run: () => engine.breakpoints().map((b) => ({ id: b.id, owner: b.owner, address: engine.describeAddress(b.address), condition: b.condition, log_message: b.logMessage, hits: b.hits })),
        },
        set_watchpoint: {
            description: "Stop when the program reads or writes memory in a range: what changed this? The machine stops after the instruction that did it. condition can test `value`, the byte read or written.",
            inputSchema: {
                type: "object",
                properties: {
                    address: addressParam,
                    length: { type: "integer" },
                    access: { type: "string", enum: ["write", "read", "readwrite"] },
                    condition: { type: "string", description: 'e.g. "value=0" or "value>&7F"' },
                },
                required: ["address"],
            },
            run: (a) => {
                const w = engine.addWatchpoint({ owner: McpOwner, address: addr(a.address), length: a.length ?? 1, access: a.access ?? "write", condition: a.condition });
                return { id: w.id, watching: `${w.length} byte(s) at ${engine.describeAddress(w.address)} for ${w.access}` };
            },
        },
        clear_watchpoint: {
            description: "Remove a watchpoint by id, or all of MCP's.",
            inputSchema: { type: "object", properties: { id: { type: "integer" } } },
            run: (a) => {
                if (a.id !== undefined) return { removed: engine.removeWatchpoint(a.id) };
                engine.clearWatchpoints(McpOwner);
                return { removed: "all" };
            },
        },
        list_watchpoints: {
            description: "Every watchpoint, with hit counts.",
            run: () => engine.watchpoints().map((w) => ({ ...w, address: engine.describeAddress(w.address) })),
        },
        get_log: {
            description: "What logpoints have reported, after sequence number `since`.",
            inputSchema: { type: "object", properties: { since: { type: "integer" }, max: { type: "integer" } } },
            run: (a) => engine.log(a.since ?? 0, a.max ?? 200).map((e) => ({ seq: e.seq, at: hex(e.pc), text: e.text })),
        },
        read_memory: {
            description: "Read memory as the CPU sees it (I/O at &FC00-&FEFF reads as &FF rather than disturbing the hardware), as a hex dump. bank reads a sideways ROM/RAM bank at &8000-&BFFF whether or not it is paged in.",
            inputSchema: {
                type: "object",
                properties: { address: addressParam, length: { type: "integer", description: "Bytes, default 64, at most 4096" }, bank: { type: "integer" } },
                required: ["address"],
            },
            run: (a) => {
                const start = addr(a.address);
                const length = Math.max(1, Math.min(4096, a.length ?? 64, 0x10000 - start));
                const bytes = engine.readMemory(start, length, { bank: a.bank });
                return { content: [{ type: "text", text: dump(engine, start, bytes) }] };
            },
        },
        write_memory: {
            description: 'Write bytes into memory: data is hex, e.g. "A9 41 20 EE FF 60".',
            inputSchema: { type: "object", properties: { address: addressParam, data: { type: "string" }, bank: { type: "integer" } }, required: ["address", "data"] },
            run: (a) => {
                const start = addr(a.address);
                const bytes = parseHexData(a.data);
                engine.writeMemory(start, bytes, { bank: a.bank });
                return { written: bytes.length, at: engine.describeAddress(start) };
            },
        },
        get_registers: {
            description: "The 6502's registers and flags.",
            run: () => {
                const r = engine.registers();
                return { pc: engine.describeAddress(r.pc), a: hex(r.a, 2), x: hex(r.x, 2), y: hex(r.y, 2), s: hex(r.s, 2), p: hex(r.p, 2), flags: engine.flagsString(r.p) };
            },
        },
        set_registers: {
            description: "Change registers or flags while stopped: any of pc, a, x, y, s, p, and the flags c z i d v n (0 or 1). Values may be expressions or symbols.",
            inputSchema: {
                type: "object",
                properties: Object.fromEntries(["pc", "a", "x", "y", "s", "p", "c", "z", "i", "d", "v", "n"].map((k) => [k, { type: ["string", "integer"] }])),
            },
            run: (a) => {
                for (const [k, v] of Object.entries(a)) engine.setRegister(k, typeof v === "number" ? v : engine.evaluate(String(v)));
                return tools.get_registers.run();
            },
        },
        disassemble: {
            description: "Disassemble instructions from an address (default PC), with symbols.",
            inputSchema: { type: "object", properties: { address: addressParam, count: { type: "integer" } } },
            run: (a) => {
                const start = a.address === undefined ? engine.cpu.pc : addr(a.address);
                const lines = engine.disassembleRange(start, Math.min(200, a.count ?? 16)).map((d) => {
                    const label = engine.symbolFor(d.address);
                    const at = engine.debugInfo.lineFor(d.address);
                    return `${label ? `.${label}\n` : ""}${hex(d.address).slice(1)}  ${hexBytes(d.bytes).padEnd(9)} ${d.text}${at ? `   ; ${path.basename(at.file)}:${at.line}` : ""}${d.address === engine.cpu.pc ? "   <- PC" : ""}`;
                });
                return { content: [{ type: "text", text: lines.join("\n") }] };
            },
        },
        evaluate: {
            description: "Evaluate an expression: registers (A X Y S P PC, flags C Z ...), symbols, ?addr for a byte, peekw(addr) for a word, BBC BASIC or C operators.",
            inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
            run: (a) => {
                const v = engine.evaluate(a.expression);
                return { value: v, hex: hex(v & 0xffff, v > 0xff ? 4 : 2) };
            },
        },
        get_screen: {
            description: "A screenshot of the BBC's display, as a PNG image.",
            run: () => ({ content: [{ type: "image", data: engine.screenshotPng().toString("base64"), mimeType: "image/png" }] }),
        },
        get_screen_text: {
            description: "The text the program has printed through the OS (OSWRCH), laid out as on screen, in any mode. Programs that write straight to screen memory don't show here: use get_screen for those.",
            inputSchema: { type: "object", properties: { clear: { type: "boolean", description: "Forget what has been read, so the next call returns only newer text" } } },
            run: (a) => ({ content: [{ type: "text", text: engine.screenText({ clear: !!a.clear }).screenText }] }),
        },
        type_text: {
            description: "Type text at the BBC keyboard, followed by RETURN unless enter is false: BASIC lines, *commands, answers to prompts. Waits until it has all been typed.",
            inputSchema: { type: "object", properties: { text: { type: "string" }, enter: { type: "boolean" } }, required: ["text"] },
            run: async (a) => {
                const wasRunning = engine.running;
                engine.type(a.text, { enter: a.enter !== false });
                if (!wasRunning) {
                    const stop = await engine.runUntilTyped();
                    if (stop) return { typed: false, stopped: stopSummary(stop) };
                    engine.resume();
                } else {
                    const deadline = Date.now() + 30000;
                    while (engine.typing && engine.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
                }
                return { typed: !engine.typing, running: engine.running };
            },
        },
        key_down: {
            description: 'Hold a key down: a name (RETURN, SHIFT, CTRL, ESCAPE, SPACE, DELETE, COPY, CAPS LOCK, F0-F9, LEFT, UP, ...), a letter or digit, or a KeyboardEvent.code ("KeyZ").',
            inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
            run: (a) => {
                engine.keyDown(a.key);
                return { down: resolveKeyCode(a.key) };
            },
        },
        key_up: {
            description: "Release a key held with key_down.",
            inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
            run: (a) => {
                engine.keyUp(a.key);
                return { up: resolveKeyCode(a.key) };
            },
        },
        press_key: {
            description: "Press and release a key, holding it for `frames` frames of emulated time (default 5); the machine runs meanwhile.",
            inputSchema: { type: "object", properties: { key: { type: "string" }, frames: { type: "integer" } }, required: ["key"] },
            run: async (a) => {
                const wasRunning = engine.running;
                const seconds = (a.frames ?? 5) / 50;
                engine.keyDown(a.key);
                try {
                    if (wasRunning) await new Promise((r) => setTimeout(r, seconds * 1000));
                    else {
                        const stop = await engine.runFor(seconds);
                        if (stop) return { pressed: true, stopped: stopSummary(stop) };
                    }
                } finally {
                    engine.keyUp(a.key);
                }
                return { pressed: true, running: engine.running };
            },
        },
        load_debug_info: {
            description: "Load symbols (and source lines) for the program: BeebAsm -labels output, a BeebAsm -v listing with its source file, a ca65 .dbg, or a VICE label file. Adds to what is loaded unless replace is true.",
            inputSchema: {
                type: "object",
                properties: { files: { type: "array", items: { type: "string" } }, source: { type: "string" }, replace: { type: "boolean" } },
                required: ["files"],
            },
            run: (a) => {
                if (a.replace) engine.clearDebugInfo();
                const kinds = engine.loadDebugInfo(a.files.map((f) => path.resolve(f)), { source: a.source && path.resolve(a.source) });
                return { kinds, symbols: engine.debugInfo.symbols.size, lines: engine.debugInfo.lines.size };
            },
        },
        resolve_symbol: {
            description: "A symbol's address.",
            inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
            run: (a) => {
                const v = engine.debugInfo.lookup(a.name);
                if (v === undefined) throw new Error(`No symbol "${a.name}"`);
                return { name: a.name, address: hex(v) };
            },
        },
        resolve_address: {
            description: "The nearest symbol to an address, and its source line if known.",
            inputSchema: { type: "object", properties: { address: addressParam }, required: ["address"] },
            run: (a) => {
                const v = addr(a.address);
                const at = engine.debugInfo.lineFor(v);
                return { address: engine.describeAddress(v), source: at ? `${at.file}:${at.line}` : undefined };
            },
        },
        save_snapshot: {
            description: "Save the whole machine to a file (jsbeeb's snapshot format, which jsbeeb's web page can load too).",
            inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            run: (a) => ({ saved: path.resolve(a.path), bytes: engine.saveSnapshot(path.resolve(a.path)) }),
        },
        load_snapshot: {
            description: "Restore the machine from a snapshot file saved by save_snapshot or by jsbeeb. Leaves it stopped.",
            inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            run: async (a) => {
                engine.pause("Loading a snapshot", { internal: true });
                const model = await engine.loadSnapshot(path.resolve(a.path));
                engine.emitStopAt("Snapshot loaded");
                return { model, at: engine.describeAddress(engine.cpu.pc) };
            },
        },
    };
    return tools;
}

/**
 * Handle one JSON-RPC message (or batch). Returns the response body, or null for notifications.
 */
export async function handleMcp(tools, message, log = () => {}) {
    if (Array.isArray(message)) {
        const out = (await Promise.all(message.map((m) => handleMcp(tools, m, log)))).filter(Boolean);
        return out.length ? out : null;
    }
    const { id, method, params } = message ?? {};
    const reply = (result) => ({ jsonrpc: "2.0", id, result });
    const fail = (code, msg) => ({ jsonrpc: "2.0", id, error: { code, message: msg } });
    if (id === undefined || id === null) return null; // a notification

    switch (method) {
        case "initialize": {
            const asked = params?.protocolVersion;
            return reply({
                protocolVersion: ProtocolVersions.includes(asked) ? asked : ProtocolVersions[0],
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: "bbc-micro", title: "BBC Micro emulator (jsbeeb)", version: "0.1.0" },
                instructions:
                    "A live BBC Micro, shared with a VS Code debugger. load_program to start something; get_screen and get_screen_text to see it; " +
                    "type_text, press_key and key_down/key_up to drive it; set_breakpoint, set_watchpoint, step and get_state to debug it. " +
                    "Addresses are BBC-style hex (&1900), $1900, 0x1900, decimal, or symbols from load_debug_info.",
            });
        }
        case "ping":
            return reply({});
        case "tools/list":
            return reply({
                tools: Object.entries(tools).map(([name, t]) => ({
                    name,
                    description: t.description,
                    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
                })),
            });
        case "tools/call": {
            const tool = tools[params?.name];
            if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
            try {
                const result = await tool.run(params.arguments ?? {});
                if (result && Array.isArray(result.content)) return reply(result);
                return reply({ content: [{ type: "text", text: JSON.stringify(result ?? { ok: true }, null, 2) }] });
            } catch (e) {
                log(`MCP ${params.name}: ${e.stack ?? e}`);
                return reply({ content: [{ type: "text", text: `Error: ${e.message ?? e}` }], isError: true });
            }
        }
        case "resources/list":
            return reply({ resources: [] });
        case "prompts/list":
            return reply({ prompts: [] });
        default:
            return fail(-32601, `Method not found: ${method}`);
    }
}
