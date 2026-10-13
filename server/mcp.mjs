// MCP (Model Context Protocol) over streamable HTTP, at POST /mcp: the same
// machine VS Code is debugging, for an AI agent to drive. Each request is
// answered with a single JSON response.
//
// The interface follows jsbeeb-mcp (github.com/mattgodbolt/jsbeeb-mcp), the
// MCP server jsbeeb's author wrote, wherever it fits: run_until_prompt,
// run_frames and run_for_cycles that hand back what was printed, keys pressed
// on the keyboard matrix by name or internal number, server-side saved
// states, sound chip capture, paged memory. It differs in one thing on
// purpose: there are no sessions. There is one machine, the one in the screen
// panel and the debugger, so an agent and a person can work on it together.
// Where the ZX Spectrum emulator has a tool for the same job (get_screen,
// get_registers, set_watchpoint, step...), the name is the ZX one.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { allModels } from "../vendor/jsbeeb/src/models.js";
import { hex } from "./engine.mjs";
import { loadProgram } from "./program.mjs";

const ProtocolVersions = ["2025-06-18", "2025-03-26", "2024-11-05"];
const McpOwner = "mcp";

// Every machine jsbeeb builds, by its short name. The Tube models are second processors, not machines.
const Machines = allModels.filter((m) => m.synonyms?.length);
const modelParam = {
    type: "string",
    enum: Machines.map((m) => m.synonyms[0]),
    description: "Machine: " + Machines.map((m) => `${m.synonyms[0]} (${m.name})`).join(", "),
};
const tubeParam = {
    type: "boolean",
    description: "Fit the second processor the model was sold with: a 3MHz 65C02 for a BBC B, the 4MHz 65C102 Turbo for a Master",
};
const addressParam = {
    type: ["string", "integer"],
    description: 'An address: &1900, $1900, 0x1900, 6400, a symbol, or an expression such as "table+2"',
};
const pagingParams = {
    bank: { type: "integer", minimum: 0, maximum: 15, description: "Sideways ROM/RAM bank to page in at &8000-&BFFF for this access" },
    shadow: { type: "boolean", description: "On a Master: shadow RAM (true) or main RAM (false) at &3000-&7FFF, whatever ACCCON says" },
};
const clearParam = {
    type: "boolean",
    description: "Take the printed output (default), so the next call returns only what is newer; false peeks at it",
};
const keyParams = {
    key: {
        type: "string",
        description:
            "The key by the machine's own name, as keyboard_state reports it. On a BBC: SHIFT, CTRL, RETURN, SPACE, DELETE, " +
            "ESCAPE, TAB, CAPSLOCK, SHIFTLOCK, COPY, UP, DOWN, LEFT, RIGHT, F0-F9, A-Z, K0-K9 (or 0-9) for the digits, and the " +
            "engraved punctuation keys: COMMA, PERIOD, SLASH, MINUS, SEMICOLON_PLUS, COLON_STAR, AT, HAT_TILDE, " +
            "UNDERSCORE_POUND, PIPE_BACKSLASH, LEFT_SQUARE_BRACKET, RIGHT_SQUARE_BRACKET. BREAK resets instead. " +
            "An unknown name is refused with the full list",
    },
    internal: { type: "integer", minimum: 0, maximum: 127, description: "BBC internal key number, as OSBYTE 121 and a game's keyboard scan use (X is 66, SPACE is 98)" },
    inkey: { type: "integer", minimum: -128, maximum: -1, description: "Negative INKEY number (X is -67, SPACE is -99)" },
    col: { type: "integer", minimum: 0, maximum: 15, description: "Keyboard matrix column, with row" },
    row: { type: "integer", minimum: 0, maximum: 15, description: "Keyboard matrix row, with col" },
};
const keySelector = (a) => ({ key: a.key, internal: a.internal, inkey: a.inkey, col: a.col, row: a.row });

// Saved states stay here and only their ids cross the connection. About 0.4MB
// each, so a cap stops a runaway caller filling the heap; at the cap,
// save_state refuses rather than evicting one somebody means to restore.
const MaxSavedStates = 100;

function hexBytes(bytes) {
    return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

function dump(start, bytes) {
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
        const row = bytes.subarray(i, i + 16);
        const ascii = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
        lines.push(`${hex(start + i)}  ${hexBytes(row).padEnd(47)}  |${ascii}|`);
    }
    return lines.join("\n");
}

function parseBytes(data) {
    if (Array.isArray(data)) {
        if (!data.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error("bytes must be 0-255");
        return Uint8Array.from(data);
    }
    const clean = String(data).replace(/[\s,]/g, "").replace(/^0x/i, "");
    if (!/^([0-9a-f]{2})*$/i.test(clean)) throw new Error('data must be hex bytes, e.g. "A9 00 60", or an array of numbers');
    return Uint8Array.from(Buffer.from(clean, "hex"));
}

/** The SN76489's writes, decoded (after jsbeeb-mcp's stop_sound_capture). */
function decodeSoundWrites(writes) {
    let latched = 0;
    return writes.map((w) => {
        const v = w.value;
        let what;
        if (v & 0x80) {
            const ch = (v >> 5) & 3;
            const data = v & 0x0f;
            latched = v & 0x70;
            if ((v >> 4) & 1) what = `CH${ch} volume attenuation ${data}${data === 15 ? " (silent)" : ""}`;
            else if (ch === 3) what = `noise ${data}`;
            else what = `CH${ch} tone low ${data}`;
        } else {
            const ch = (latched >> 5) & 3;
            const data = v & 0x3f;
            what = (latched >> 4) & 1 ? `CH${ch} volume data ${data}` : `CH${ch} tone high ${data}${(v >> 6) & 1 ? " [bit 6]" : ""}`;
        }
        return `${w.cycle}: ${hex(v, 2)} ${what}`;
    });
}

export function makeTools(engine, serverInfo) {
    const addr = (v) => engine.resolveAddress(v);
    const states = new Map(); // id -> { model, label, saved_at, snapshot }

    const stoppedReason = (stop) => {
        if (stop.timedOut) return "timeout";
        if (/breakpoint/.test(stop.reason)) return stop.reason === "data breakpoint" ? "watchpoint" : "breakpoint";
        return stop.reason === "pause" ? "paused" : stop.reason;
    };

    /**
     * What every tool that runs the machine and waits reports: whether it got
     * where it was going, why it stopped if not, where the CPU is, how far it
     * ran, and what was printed meanwhile.
     */
    const runResult = (stop, { startCycles, startFrame, clear = true, extra = {} } = {}) => {
        const result = { completed: !stop, ...extra };
        if (stop) {
            result.stopped_reason = stoppedReason(stop);
            result.stopped = stop.description;
            if (stop.breakpointIds?.length) result.breakpoint_ids = stop.breakpointIds;
        }
        if (startCycles !== undefined) result.cycles_run = engine.elapsedCycles - startCycles;
        if (startFrame !== undefined) result.frames_run = engine.frameCount - startFrame;
        result.registers = engine.registerReport();
        result.output = engine.takeOutput({ clear });
        return result;
    };

    /**
     * Run the machine for a tool and wait: pause it first if it is running
     * live, and when the run ends where it was meant to, tell the debugger the
     * machine is now stopped there. A stop by a breakpoint has said so already.
     */
    const runAndReport = async (description, fn, opts = {}) => {
        engine.pause(description, { internal: true });
        const startCycles = engine.elapsedCycles;
        const startFrame = engine.frameCount;
        const stop = await fn();
        if (!stop || stop.internal) engine.emitStopAt(stop?.description ?? description, "pause");
        return runResult(stop, { startCycles, startFrame, ...opts });
    };

    /** name -> { description, inputSchema, run(args) -> result | {content} } */
    const tools = {
        // --- the machine ---------------------------------------------------
        server_info: {
            description: "Which emulator this is: its version, the emulated model, the ports it serves DAP, MCP and the screen on, and the program last loaded.",
            run: () => serverInfo(),
        },
        get_state: {
            description: "The machine at a glance: running or stopped and why, registers and flags, the instruction at PC, breakpoints, watchpoints, a guess at the call stack, and cycles and frames run.",
            run: () => engine.state(),
        },
        reset: {
            description:
                "Reset the machine: power-on (hard, the default) or BREAK (hard: false); model or tube switch to another machine first. " +
                "autoboot holds SHIFT through the reset (SHIFT-BREAK) to boot the disc in drive 0, and reports shift_held_at_reset. " +
                "Typing still pending is dropped (cancelled_typing). Leaves the machine running.",
            inputSchema: { type: "object", properties: { hard: { type: "boolean" }, autoboot: { type: "boolean" }, model: modelParam, tube: tubeParam } },
            run: async (a) => {
                engine.pause("Reset", { internal: true });
                const cancelled = engine.cancelTyping();
                let shiftHeld;
                if (a.autoboot) {
                    engine.pressMatrixKey({ key: "SHIFT" }, true);
                    try {
                        await engine.reset({ hard: a.hard !== false, model: a.model, tube: a.tube });
                        shiftHeld = engine.keyboardState().held_keys.some((k) => k.name === "SHIFT");
                        await engine.runFor(1);
                    } finally {
                        engine.pressMatrixKey({ key: "SHIFT" }, false);
                    }
                } else {
                    await engine.reset({ hard: a.hard !== false, model: a.model, tube: a.tube });
                }
                engine.resume();
                return { reset: true, model: engine.model.name, tube: engine.tube, autoboot: !!a.autoboot, shift_held_at_reset: shiftHeld, cancelled_typing: cancelled };
            },
        },

        // --- loading -------------------------------------------------------
        load_program: {
            description:
                "Reset the machine, load a program and start it: the usual way in. .ssd/.dsd/.adf discs (or a zip, or a disc reference as load_disc " +
                "takes) boot with SHIFT-BREAK; .uef tapes are CHAINed; .bas files are BBC BASIC source, tokenised and RUN; anything else is a raw " +
                "binary, which needs load_address. Left running unless stop_at is given or a breakpoint stops it.",
            inputSchema: {
                type: "object",
                properties: {
                    path: { type: "string", description: "The file, or for a disc a reference such as sth:Acornsoft/Elite.zip" },
                    model: modelParam,
                    tube: tubeParam,
                    load_address: addressParam,
                    exec_address: addressParam,
                    run: { type: "string", description: 'What to type to start it instead of the default, e.g. "*RUN GAME" or "CHAIN \\"MENU\\""' },
                    boot: { type: "boolean", description: "Start the program (default true); false loads it and leaves the machine at the BASIC prompt" },
                    debug_info: { type: "array", items: { type: "string" }, description: "Symbol files: BeebAsm -labels output, a BeebAsm -v listing (with source), a ca65 .dbg, or VICE labels" },
                    source: { type: "string", description: "The main source file a BeebAsm listing came from" },
                    stop_at: addressParam,
                },
                required: ["path"],
            },
            run: async (a) => {
                const isRef = /^(sth|hfe|bitshifters|https?|file):/i.test(a.path);
                const r = await loadProgram(engine, {
                    program: isRef ? a.path : path.resolve(a.path),
                    model: a.model,
                    tube: a.tube,
                    loadAddress: a.load_address,
                    execAddress: a.exec_address,
                    run: a.run,
                    boot: a.boot,
                    debugInfo: a.debug_info?.map((f) => path.resolve(f)),
                    source: a.source && path.resolve(a.source),
                    stopAt: a.stop_at,
                });
                if (!r.stop) engine.resume();
                const out = { loaded: r.description, kind: r.kind, running: engine.running };
                if (r.stop) Object.assign(out, { stopped_reason: stoppedReason(r.stop), stopped: r.stop.description, registers: engine.registerReport() });
                return out;
            },
        },
        load_disc: {
            description:
                "Put a disc in a drive without resetting or booting: from a file here (.ssd, .dsd, .adf, or a zip holding one), a file: or http(s): URL, " +
                "'sth:Acornsoft/Elite.zip' (Stairway to Hell), or 'hfe:<path>' (the BBC disc archive). Then type_text '*CAT', '*RUN NAME' or 'CHAIN\"NAME\"'; " +
                "a disc in drive 1 is ':1.NAME'.",
            inputSchema: { type: "object", properties: { image: { type: "string" }, drive: { type: "integer", minimum: 0, maximum: 1 } }, required: ["image"] },
            run: async (a) => {
                const { name, ignored } = await engine.loadDiscRef(a.image, a.drive ?? 0);
                return { disc: name, drive: a.drive ?? 0, ignored };
            },
        },
        boot_disc: {
            description: "Load a disc (as load_disc takes it) into drive 0 and boot it with SHIFT-BREAK, keeping the model. Leaves the machine running; reports shift_held_at_reset.",
            inputSchema: { type: "object", properties: { image: { type: "string" } }, required: ["image"] },
            run: async (a) => {
                engine.pause("Booting a disc", { internal: true });
                const { name, ignored } = await engine.loadDiscRef(a.image, 0);
                const booted = await tools.reset.run({ autoboot: true, hard: true });
                return { disc: name, ignored, shift_held_at_reset: booted.shift_held_at_reset, cancelled_typing: booted.cancelled_typing };
            },
        },
        load_basic: {
            description: "Tokenise BBC BASIC source and put it at PAGE, as if typed in. Does not run it: type_text RUN, then run_until_prompt.",
            inputSchema: { type: "object", properties: { source: { type: "string" } }, required: ["source"] },
            run: async (a) => {
                await engine.loadBasic(a.source);
                return { loaded: true, lines: a.source.split(/\r?\n/).filter((l) => l.trim()).length };
            },
        },
        run_basic: {
            description:
                "One step for trying BASIC: reset the machine, load the program, RUN it until it waits at a prompt (or timeout_secs of emulated time pass), " +
                "and return what it printed and a screenshot. The machine is left stopped where the program finished.",
            inputSchema: {
                type: "object",
                properties: { source: { type: "string" }, model: modelParam, timeout_secs: { type: "number" }, screenshot: { type: "boolean", description: "Include a screenshot (default true)" } },
                required: ["source"],
            },
            run: async (a) => {
                engine.pause("run_basic", { internal: true });
                await engine.reset({ hard: true, model: a.model });
                const boot = await engine.bootToPrompt();
                if (boot) return runResult(boot);
                engine.takeOutput();
                await engine.loadBasic(a.source);
                engine.type("RUN");
                const result = await runAndReport("run_basic", () => engine.runUntilPrompt(a.timeout_secs ?? 30));
                const content = [{ type: "text", text: JSON.stringify(result, null, 2) }];
                if (a.screenshot !== false) content.push({ type: "image", data: engine.screenshotPng().toString("base64"), mimeType: "image/png" });
                return { content };
            },
        },

        // --- running -------------------------------------------------------
        run: {
            description: "Let the machine run on in real time, as the screen panel shows it, until a breakpoint, a watchpoint or pause. With wait_ms, wait that long for it to stop and report how.",
            inputSchema: { type: "object", properties: { wait_ms: { type: "integer" } } },
            run: async (a) => {
                engine.resume();
                if (!(a.wait_ms > 0)) return { running: true };
                const stop = await engine.waitForStop(a.wait_ms);
                if (!stop) return { running: engine.running };
                return runResult(stop, { clear: false });
            },
        },
        pause: {
            description: "Stop a running machine where it is.",
            run: () => ({ paused: engine.pause(), registers: engine.registerReport() }),
        },
        run_until_prompt: {
            description:
                "Run until the machine waits for a key: back at the BASIC or * prompt, or a program's INPUT or GET. The way to let something " +
                "typed (RUN, a *command) finish. Returns what was printed since output was last taken. Anything still being typed is typed first.",
            inputSchema: { type: "object", properties: { timeout_secs: { type: "number", description: "Emulated seconds to allow (default 60)" }, clear: clearParam } },
            run: (a) => runAndReport("Run until the prompt", () => engine.runUntilPrompt(a.timeout_secs ?? 60), { clear: a.clear !== false }),
        },
        run_frames: {
            description:
                "Run until another `count` frames have been painted, stopping on the paint itself: one frame is one new picture for get_screen. " +
                "Use this, not run_for_cycles, to step animation, catch flicker, or let a game move on. Reports frames_run and frame_count, which only climbs.",
            inputSchema: { type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 10000 }, clear: clearParam } },
            run: (a) => runAndReport(`Ran ${a.count ?? 1} frame(s)`, () => engine.runFrames(a.count ?? 1), { clear: a.clear !== false }),
        },
        run_for_cycles: {
            description:
                "Run for a number of CPU cycles (2MHz on a BBC): exact timing, to within the instruction that finishes it. Not for stepping the display " +
                "(a frame is 40000 cycles interlaced, 39936 not): use run_frames. Reports cycles_run.",
            inputSchema: { type: "object", properties: { cycles: { type: "integer", minimum: 1 }, clear: clearParam }, required: ["cycles"] },
            run: (a) => runAndReport(`Ran ${a.cycles} cycles`, () => engine.runCycles(a.cycles), { clear: a.clear !== false }),
        },
        run_to: {
            description: "Run until PC reaches an address (a one-off breakpoint), giving up after timeout_seconds of emulated time.",
            inputSchema: { type: "object", properties: { address: addressParam, timeout_seconds: { type: "number" } }, required: ["address"] },
            run: (a) => runAndReport("Run to", () => engine.runUntil(addr(a.address), a.timeout_seconds ?? 20)),
        },
        step: {
            description:
                'Execute instructions and stop. mode "into" (default) runs `count` instructions; "over" runs a JSR to its return; "out" runs to the ' +
                "RTS of the current subroutine. An interrupt taken meanwhile is run through as if it were one instruction.",
            inputSchema: { type: "object", properties: { count: { type: "integer", minimum: 1 }, mode: { type: "string", enum: ["into", "over", "out"] } } },
            run: async (a) => {
                engine.pause("Step", { internal: true });
                const mode = a.mode ?? "into";
                const count = Math.max(1, a.count ?? 1);
                const startCycles = engine.elapsedCycles;
                let stop;
                for (let i = 0; i < (mode === "into" ? 1 : count); i++) {
                    if (mode === "over") engine.stepOver();
                    else if (mode === "out") engine.stepOut();
                    else engine.stepCount(count);
                    stop = await engine.waitForStop();
                    if (stop.reason !== "step" || stop.timedOut) break;
                }
                return runResult(stop.reason === "step" && !stop.timedOut ? null : stop, { startCycles, clear: false });
            },
        },

        // --- breakpoints ---------------------------------------------------
        set_breakpoint: {
            description:
                'Stop when execution reaches an address. condition is an expression ("A=&41", "?&70>3", "X<>0 AND C"); hit_count waits for the nth ' +
                "hit; log_message makes a logpoint that records a message ({expressions} in braces) instead of stopping. type read or write makes it a " +
                "watchpoint on that address instead, as set_watchpoint does.",
            inputSchema: {
                type: "object",
                properties: {
                    address: addressParam,
                    type: { type: "string", enum: ["execute", "read", "write"] },
                    condition: { type: "string" },
                    hit_count: { type: "string", description: 'e.g. "3" (from the 3rd hit), "==5", "%10"' },
                    log_message: { type: "string" },
                },
                required: ["address"],
            },
            run: (a) => {
                if (a.type === "read" || a.type === "write") return tools.set_watchpoint.run({ address: a.address, access: a.type, condition: a.condition });
                const existing = engine.breakpoints(McpOwner).map(({ id, address, condition, hitCondition, logMessage, kind }) => ({ id, address, condition, hitCondition, logMessage, kind }));
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
            description: "Remove one of MCP's breakpoints, by address or by id; with neither, all of them.",
            inputSchema: { type: "object", properties: { address: addressParam, id: { type: "integer" } } },
            run: (a) => {
                const all = engine.breakpoints(McpOwner);
                const target = a.address !== undefined ? addr(a.address) : undefined;
                const keep = a.address === undefined && a.id === undefined ? [] : all.filter((b) => b.address !== target && b.id !== a.id);
                engine.setBreakpoints(McpOwner, keep);
                return { removed: all.length - keep.length, remaining: keep.map((b) => engine.describeAddress(b.address)) };
            },
        },
        list_breakpoints: {
            description: "Every breakpoint and logpoint set, by MCP or by VS Code, with hit counts.",
            run: () =>
                engine
                    .breakpoints()
                    .filter((b) => !b.internal)
                    .map((b) => ({ id: b.id, owner: b.owner, address: engine.describeAddress(b.address), condition: b.condition, hit_count: b.hitCondition, log_message: b.logMessage, hits: b.hits })),
        },
        set_watchpoint: {
            description: "Stop when the program reads or writes memory in a range: what changed this? The machine stops after the instruction that did it. condition can test `value`, the byte read or written.",
            inputSchema: {
                type: "object",
                properties: {
                    address: addressParam,
                    length: { type: "integer", minimum: 1 },
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

        // --- memory and CPU ------------------------------------------------
        read_memory: {
            description:
                "Read memory as the CPU sees it, as a hex dump, with paging: romsel (the sideways bank at &8000-&BFFF) and on a Master acccon, so a read " +
                "of paged memory says which bank it came from. bank or shadow read a particular one instead. I/O at &FC00-&FEFF reads as &FF rather " +
                "than disturbing the hardware.",
            inputSchema: { type: "object", properties: { address: addressParam, length: { type: "integer", minimum: 1, maximum: 4096, description: "Bytes, default 64" }, ...pagingParams }, required: ["address"] },
            run: (a) => {
                const start = addr(a.address);
                const length = Math.max(1, Math.min(4096, a.length ?? 64, 0x10000 - start));
                const bytes = engine.readMemory(start, length, { bank: a.bank, shadow: a.shadow });
                const paging = { ...engine.paging(), ...(a.bank !== undefined && { bank: a.bank }), ...(a.shadow !== undefined && { shadow: a.shadow }) };
                return { content: [{ type: "text", text: `${dump(start, bytes)}\npaging: ${JSON.stringify(paging)}` }] };
            },
        },
        write_memory: {
            description: 'Write bytes into memory: data is hex ("A9 41 20 EE FF 60") or an array of numbers. bank and shadow as for read_memory.',
            inputSchema: {
                type: "object",
                properties: { address: addressParam, data: { type: ["string", "array"], items: { type: "integer" } }, ...pagingParams },
                required: ["address", "data"],
            },
            run: (a) => {
                const start = addr(a.address);
                const bytes = parseBytes(a.data);
                engine.writeMemory(start, bytes, { bank: a.bank, shadow: a.shadow });
                return { written: bytes.length, at: engine.describeAddress(start) };
            },
        },
        save_memory: {
            description: "Save a range of memory to a file on this computer: quicker than read_memory for big dumps. bank and shadow as for read_memory.",
            inputSchema: {
                type: "object",
                properties: { address: addressParam, length: { type: "integer", minimum: 1, maximum: 65536 }, path: { type: "string" }, ...pagingParams },
                required: ["address", "length", "path"],
            },
            run: (a) => {
                const start = addr(a.address);
                const length = Math.min(a.length, 0x10000 - start);
                const file = path.resolve(a.path);
                fs.writeFileSync(file, engine.readMemory(start, length, { bank: a.bank, shadow: a.shadow }));
                return { saved: length, from: hex(start), path: file, paging: engine.paging() };
            },
        },
        get_registers: {
            description: "The 6502's registers and flags, the instruction at PC, and the frame and cycle counters.",
            run: () => engine.registerReport(),
        },
        set_registers: {
            description: "Change registers or flags while stopped: any of pc, a, x, y, s, p, and the flags c z i d v n (0 or 1). Values may be expressions or symbols.",
            inputSchema: {
                type: "object",
                properties: Object.fromEntries(["pc", "a", "x", "y", "s", "p", "c", "z", "i", "d", "v", "n"].map((k) => [k, { type: ["string", "integer"] }])),
            },
            run: (a) => {
                for (const [k, v] of Object.entries(a)) engine.setRegister(k, typeof v === "number" ? v : engine.evaluate(String(v)));
                return engine.registerReport();
            },
        },
        disassemble: {
            description: "Disassemble instructions from an address (default PC), with symbols and source lines where known.",
            inputSchema: { type: "object", properties: { address: addressParam, count: { type: "integer", minimum: 1, maximum: 200 } } },
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

        // --- the screen ----------------------------------------------------
        get_screen: {
            description:
                "A screenshot of the last complete frame, as a PNG, with frame_count so a new picture can be told from the same one twice. " +
                "scale 2 doubles it for a closer look. To see the next frame, run_frames first.",
            inputSchema: { type: "object", properties: { scale: { type: "integer", minimum: 1, maximum: 4 } } },
            run: (a) => ({
                content: [
                    { type: "text", text: JSON.stringify({ frame_count: engine.frameCount }) },
                    { type: "image", data: engine.screenshotPng({ scale: a.scale ?? 1 }).toString("base64"), mimeType: "image/png" },
                ],
            }),
        },
        get_screen_text: {
            description:
                "The text printed through the OS (OSWRCH) that has not been taken yet, laid out as on screen, in any mode. The run tools take it as they " +
                "go, so this is what was printed since. Programs writing straight to screen memory don't show here: get_screen does.",
            inputSchema: { type: "object", properties: { clear: { type: "boolean", description: "Take it (default false: peek)" } } },
            run: (a) => ({ content: [{ type: "text", text: engine.takeOutput({ clear: !!a.clear }) }] }),
        },

        // --- the keyboard --------------------------------------------------
        type_text: {
            description:
                "Type text at the keyboard, then RETURN unless enter is false: BASIC lines, *commands, answers to prompts. Waits until it has all been typed " +
                "(run_until_prompt then lets it finish). A breakpoint can stop it part way: completed is false, and the rest is typed as the machine runs on; " +
                "until then key_down and key_up refuse, and release_all_keys drops it.",
            inputSchema: { type: "object", properties: { text: { type: "string" }, enter: { type: "boolean" } }, required: ["text"] },
            run: async (a) => {
                if (engine.running) {
                    engine.type(a.text, { enter: a.enter !== false });
                    const deadline = Date.now() + 30000;
                    while (engine.typing && engine.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
                    return { typed: a.text, completed: !engine.typing, running: engine.running };
                }
                engine.type(a.text, { enter: a.enter !== false });
                const result = await runAndReport("Typed", () => engine.runUntilTyped(), { clear: false });
                return { typed: a.text, ...result, completed: result.completed && !engine.typing };
            },
        },
        key_down: {
            description:
                "Press and hold a key, straight on the keyboard matrix with no host keyboard layout in between: what a game's own keyboard scan reads. " +
                "Name it one way: key (the machine's name), internal, inkey, or col and row. Reports the matrix key that went down, with its name and numbers. " +
                "The machine does not run meanwhile: run, run_frames or press_key let it see the key.",
            inputSchema: { type: "object", properties: keyParams },
            run: (a) => ({ pressed: engine.pressMatrixKey(keySelector(a), true) }),
        },
        key_up: {
            description: "Release a held key, named any way key_down takes. Reports the matrix keys that came up.",
            inputSchema: { type: "object", properties: keyParams },
            run: (a) => ({ released: engine.pressMatrixKey(keySelector(a), false) }),
        },
        press_key: {
            description: "Press a key (named as key_down takes), hold it for `frames` painted frames (default 5) while the machine runs, and release it.",
            inputSchema: { type: "object", properties: { ...keyParams, frames: { type: "integer", minimum: 1 }, clear: clearParam } },
            run: async (a) => {
                const pressed = engine.pressMatrixKey(keySelector(a), true);
                let result;
                try {
                    result = await runAndReport("Pressed a key", () => engine.runFrames(a.frames ?? 5), { clear: a.clear !== false });
                } finally {
                    engine.pressMatrixKey(keySelector(a), false);
                }
                return { pressed, ...result };
            },
        },
        keyboard_state: {
            description: "The keyboard as the machine sees it: every key held, by matrix column and row, name, internal key number and INKEY number; and whether typed text is still pending.",
            run: () => engine.keyboardState(),
        },
        release_all_keys: {
            description: "Release every held key and drop any typing still pending, so the keyboard is in a known state. Reports what was released.",
            run: () => {
                const before = engine.keyboardState();
                engine.cancelTyping();
                engine.releaseAllKeys();
                return { released: before.held_keys, cancelled_typing: before.typing_pending };
            },
        },

        // --- saved states ----------------------------------------------------
        save_state: {
            description:
                "Snapshot the whole machine (CPU, RAM, sideways RAM, video, sound, discs, tube) and keep it here under a state_id. Booting and loading " +
                "are the slow part, so save once and restore_state between attempts. Only the id crosses the connection; free states with delete_state.",
            inputSchema: { type: "object", properties: { label: { type: "string", maxLength: 200 } } },
            run: (a) => {
                if (states.size >= MaxSavedStates) throw new Error(`Already holding ${states.size} saved states (the limit): free one with delete_state; list_states shows them`);
                const state_id = randomUUID();
                states.set(state_id, { model: engine.model.name, tube: engine.tube, label: a.label ?? "", saved_at: new Date().toISOString(), pc: engine.cpu.pc, snapshot: engine.session.snapshot() });
                return { state_id, model: engine.model.name, label: a.label ?? "", at: engine.describeAddress(engine.cpu.pc) };
            },
        },
        restore_state: {
            description: "Put the machine back to a state from save_state (switching model if need be). Memory, registers and the cycle count rewind; breakpoints and the frame counter carry on. Leaves it stopped.",
            inputSchema: { type: "object", properties: { state_id: { type: "string" } }, required: ["state_id"] },
            run: async (a) => {
                const saved = states.get(a.state_id);
                if (!saved) throw new Error(`No state "${a.state_id}": list_states shows what is held`);
                engine.pause("Restoring a state", { internal: true });
                if (saved.model !== engine.model.name || saved.tube !== engine.tube) await engine.reset({ model: saved.model, tube: saved.tube });
                engine.restore(saved.snapshot);
                engine.emitStopAt(`Restored state ${saved.label || a.state_id}`, "pause");
                return { state_id: a.state_id, model: saved.model, label: saved.label, registers: engine.registerReport() };
            },
        },
        list_states: {
            description: "The states save_state holds, newest first.",
            run: () =>
                [...states]
                    .map(([state_id, s]) => ({ state_id, model: s.model, label: s.label, saved_at: s.saved_at, at: hex(s.pc) }))
                    .sort((x, y) => y.saved_at.localeCompare(x.saved_at)),
        },
        delete_state: {
            description: "Discard a saved state and free its memory.",
            inputSchema: { type: "object", properties: { state_id: { type: "string" } }, required: ["state_id"] },
            run: (a) => {
                if (!states.delete(a.state_id)) throw new Error(`No state "${a.state_id}"`);
                return { deleted: a.state_id };
            },
        },
        save_snapshot: {
            description: "Save the whole machine to a file, in jsbeeb's snapshot format with the disc contents included, to keep beyond this server's life.",
            inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            run: (a) => ({ saved: path.resolve(a.path), bytes: engine.saveSnapshot(path.resolve(a.path)) }),
        },
        load_snapshot: {
            description: "Restore the machine from a file saved by save_snapshot. Leaves it stopped.",
            inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            run: async (a) => {
                engine.pause("Loading a snapshot", { internal: true });
                const model = await engine.loadSnapshot(path.resolve(a.path));
                engine.emitStopAt("Snapshot loaded");
                return { model, registers: engine.registerReport() };
            },
        },

        // --- sound -----------------------------------------------------------
        read_sound_state: {
            description: "The SN76489 sound chip's registers: each tone channel's period (and frequency) and volume, the noise register, the latched register and the LFSR.",
            run: () => {
                const sc = engine.session._soundChip;
                if (!sc?.getState) throw new Error("This machine has no sound chip to read");
                const st = sc.getState();
                const freq = (t) => (t === 0 ? 0 : Math.round((4000000 / (32 * t)) * 10) / 10);
                return {
                    channels: [0, 1, 2].map((c) => ({ channel: c, period: st.tone[c], hz: freq(st.tone[c]), attenuation: st.volume[c] })),
                    noise: { register: st.noise, attenuation: st.volume[3] },
                    latched_register: hex(st.latchedRegister, 2),
                    lfsr: hex(st.lfsr, 4),
                };
            },
        },
        start_sound_capture: {
            description: "Log every byte written to the sound chip, with its cycle, until stop_sound_capture. Clears any earlier log.",
            run: () => {
                const sc = engine.session._soundChip;
                if (!sc?.startCapture) throw new Error("This machine has no sound chip to capture");
                sc.startCapture();
                return { capturing: true };
            },
        },
        stop_sound_capture: {
            description: "Stop logging sound chip writes and return them decoded (channel, tone or volume, value), the most recent max_entries (default 500).",
            inputSchema: { type: "object", properties: { max_entries: { type: "integer", minimum: 1 } } },
            run: (a) => {
                const sc = engine.session._soundChip;
                if (!sc?.stopCapture) throw new Error("This machine has no sound chip to capture");
                const writes = sc.stopCapture();
                const max = a.max_entries ?? 500;
                const header = writes.length > max ? `Last ${max} of ${writes.length} writes:` : `${writes.length} writes:`;
                return { content: [{ type: "text", text: [header, ...decodeSoundWrites(writes.slice(-max))].join("\n") }] };
            },
        },

        // --- symbols ---------------------------------------------------------
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
                    "One live BBC Micro, shared with a VS Code debugger and its screen panel: there are no sessions to create. " +
                    "To try BASIC: run_basic. To run a program: load_program (a disc, tape, .bas or binary), or load_disc and type_text. " +
                    "type_text then run_until_prompt runs a command and returns what it printed; run_frames steps the display; get_screen shows it. " +
                    "key_down/key_up/press_key press keys on the matrix by name (SHIFT, RETURN, Z) or internal number. " +
                    "save_state once things are set up, restore_state between attempts. " +
                    "set_breakpoint, set_watchpoint, step, get_state and disassemble to debug. " +
                    "Addresses are &1900, $1900, 0x1900, decimal, or symbols from load_debug_info.",
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
