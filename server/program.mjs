// Getting a program into the machine and started, the same way for a DAP
// launch and for MCP's load_program.
//
//   .ssd/.dsd  disc in drive 0; booted with SHIFT-BREAK, or `run` typed after it
//   .uef       tape in the recorder, then *TAPE and CHAIN""  (or `run`)
//   .bas/.txt  BBC BASIC source, tokenised into PAGE, then RUN
//   anything else: a raw binary, loaded at `loadAddress` and entered at `execAddress`
//
// Everything is done with the machine stopped at the BASIC prompt first, so
// the MOS has set up the memory map, and the program then runs on from there.

import fs from "node:fs";
import path from "node:path";
import { hex } from "./engine.mjs";
import { parseNumber } from "./expr.mjs";

function addressOf(engine, value, what) {
    if (value === undefined || value === null || value === "") return undefined;
    const n = typeof value === "number" ? value : (parseNumber(value) ?? engine.resolveAddress(value));
    if (n === undefined || Number.isNaN(n)) throw new Error(`${what} "${value}" is not an address`);
    return n & 0xffff;
}

const DiscRef = /^(sth|hfe|bitshifters|https?|file):/i;

export function programKind(file) {
    if (DiscRef.test(file)) return "disc";
    const ext = path.extname(file).toLowerCase();
    if ([".ssd", ".dsd", ".adf", ".adl", ".zip"].includes(ext)) return "disc";
    if (ext === ".uef") return "tape";
    if (ext === ".bas" || ext === ".txt" || ext === ".bbc") return "basic";
    return "binary";
}

/**
 * @param {import("./engine.mjs").Engine} engine
 * @param {object} opts
 * @param {string} opts.program
 * @param {string} [opts.model]
 * @param {string|number} [opts.loadAddress] binary only
 * @param {string|number} [opts.execAddress] binary only; defaults to loadAddress
 * @param {string} [opts.run] what to type to start a disc or tape program instead of the default
 * @param {boolean} [opts.boot=true] start the program (false: load it and stop at the prompt)
 * @param {string[]} [opts.debugInfo] symbol, listing or .dbg files
 * @param {string} [opts.source] the main source file, for a BeebAsm listing
 * @param {string|number} [opts.stopAt] stop on arrival at this address (or symbol) once started
 * @returns {Promise<{kind: string, description: string, stop: object|null}>}
 */
export async function loadProgram(engine, opts) {
    try {
        return await load(engine, opts);
    } finally {
        engine.setBreakpoints(StopAtOwner, []);
    }
}

// stopAt is a breakpoint from the moment the program is put in the machine:
// a program started by SHIFT-BREAK may have run, and finished, before the
// keys that started it are even released.
const StopAtOwner = "load:stopAt";

function arrived(engine, stop, stopAt) {
    return stop && stopAt !== undefined && stop.breakpointIds?.length && engine.cpu.pc === stopAt && engine.breakpoints(StopAtOwner).some((b) => stop.breakpointIds.includes(b.id));
}

async function load(engine, opts) {
    const program = opts.program && path.resolve(opts.program);
    if (program && !DiscRef.test(program) && !fs.existsSync(program)) throw new Error(`No such file: ${program}`);
    engine.pause("Loading", { internal: true });
    await engine.reset({ hard: true, model: opts.model, tube: opts.tube });
    engine.clearDebugInfo();
    if (opts.debugInfo?.length) engine.loadDebugInfo(opts.debugInfo, { source: opts.source });

    let stop = await engine.bootToPrompt();
    if (stop) return { kind: "boot", description: "A breakpoint stopped the machine while it booted", stop };
    if (!program) return { kind: "none", description: "Booted to the prompt", stop: null };

    const kind = programKind(program);
    const boot = opts.boot !== false;
    const stopAt = addressOf(engine, opts.stopAt, "stopAt");
    if (stopAt !== undefined) engine.setBreakpoints(StopAtOwner, [{ address: stopAt, kind: "instruction", internal: true }]);
    let description;
    let typed = null;

    switch (kind) {
        case "disc": {
            const { name } = await engine.loadDiscRef(program);
            description = `Disc ${name ?? path.basename(program)} in drive 0`;
            if (boot) {
                if (opts.run) typed = opts.run;
                else {
                    // SHIFT-BREAK: reset with SHIFT held boots the disc's !BOOT.
                    engine.keyDown("SHIFT");
                    await engine.reset({ hard: false });
                    stop = await engine.runFor(1.5);
                    engine.keyUp("SHIFT");
                    description += ", booted with SHIFT-BREAK";
                    if (stop) return finish(engine, { kind, description, stop }, stopAt);
                }
            }
            break;
        }
        case "tape": {
            await engine.loadTape(program);
            description = `Tape ${path.basename(program)} in the recorder`;
            if (boot) typed = opts.run ?? '*TAPE\rCHAIN""';
            break;
        }
        case "basic": {
            await engine.loadBasic(fs.readFileSync(program, "utf8"));
            description = `BASIC program ${path.basename(program)} at PAGE`;
            if (boot) typed = opts.run ?? "RUN";
            break;
        }
        default: {
            const load = addressOf(engine, opts.loadAddress, "loadAddress");
            if (load === undefined) throw new Error(`${path.basename(program)} is a raw binary: say where it goes with loadAddress`);
            const exec = addressOf(engine, opts.execAddress, "execAddress") ?? load;
            const length = engine.loadBinary(program, load);
            description = `${path.basename(program)}: ${length} bytes at ${hex(load)}`;
            if (boot) {
                // Enter it the way *RUN would, by calling it from BASIC.
                typed = opts.run ?? `CALL ${hex(exec)}`;
            }
            break;
        }
    }

    if (typed !== null) {
        description += `, started with ${JSON.stringify(typed)}`;
        engine.type(typed.replace(/\\r/g, "\r"));
    }
    if (typed !== null) {
        stop = await engine.runUntilTyped();
        if (stop) return finish(engine, { kind, description, stop }, stopAt);
    }
    if (stopAt !== undefined) {
        stop = await engine.runUntil(stopAt, 60);
        return finish(engine, { kind, description, stop: stop ?? { reason: "step" } }, stopAt);
    }
    return { kind, description, stop: null };
}

/**
 * The loading runs stop quietly; say why the machine has stopped now it is
 * the user's: arrival at stopAt as an entry stop, a run that gave up as a
 * pause. A user's breakpoint has said so already.
 */
function finish(engine, result, stopAt) {
    const atTarget = stopAt !== undefined && engine.cpu.pc === stopAt && (result.stop.reason === "step" || arrived(engine, result.stop, stopAt));
    if (atTarget) engine.emitStopAt(`Stopped on arrival at ${engine.describeAddress(stopAt)}`);
    else if (result.stop.internal || !result.stop.description) engine.emitStopAt(result.stop.description ?? "Stopped", "pause");
    else return result;
    return { ...result, stop: engine.lastStop };
}
