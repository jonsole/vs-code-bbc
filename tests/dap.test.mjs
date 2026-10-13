// The DAP server end to end, as VS Code drives it: launch the hello example
// with its BeebAsm listing, stop at a source breakpoint, look around, step.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { startServer, DapClient, Hello } from "./helpers.mjs";

const require = createRequire(import.meta.url);

const src = path.join(Hello, "hello.6502");
const lines = fs.readFileSync(src, "utf8").split(/\r?\n/);
const lineIs = (text) => lines.findIndex((l) => l.trim() === text) + 1;

test("DAP: launch, source breakpoint, inspect, step, continue", async (t) => {
    const server = await startServer(["--paused"]);
    const dap = new DapClient(server.dapPort);
    t.after(async () => {
        dap.close();
        await server.stop();
    });
    await dap.connect();
    const caps = await dap.request("initialize", { adapterID: "bbcmicro", linesStartAt1: true, columnsStartAt1: true });
    assert.ok(caps.supportsDisassembleRequest && caps.supportsDataBreakpoints && caps.supportsLogPoints);

    const launched = dap.request("launch", {
        program: path.join(Hello, "build/hello.ssd"),
        debugInfo: [path.join(Hello, "build/hello.labels"), path.join(Hello, "build/hello.lst")],
        source: src,
    });
    await dap.waitFor("initialized", { since: 0 });
    const bpLine = lineIs("INC counter");
    const bps = await dap.request("setBreakpoints", { source: { path: src }, breakpoints: [{ line: bpLine }, { line: lines.length + 5 }] });
    assert.equal(bps.breakpoints[0].verified, true);
    assert.equal(bps.breakpoints[0].instructionReference, "0x1911");
    assert.equal(bps.breakpoints[1].verified, false, "a line past the code can't take a breakpoint");
    await dap.request("configurationDone");
    await launched;

    const stopped = await dap.waitFor("stopped", { timeout: 30000 });
    assert.equal(stopped.body.reason, "breakpoint");
    assert.deepEqual(stopped.body.hitBreakpointIds, [bps.breakpoints[0].id]);

    const { stackFrames } = await dap.request("stackTrace", { threadId: 1 });
    assert.equal(stackFrames[0].source.path, src);
    assert.equal(stackFrames[0].line, bpLine);
    assert.equal(stackFrames[0].instructionPointerReference, "0x1911");

    const { scopes } = await dap.request("scopes", { frameId: 0 });
    const regs = await dap.request("variables", { variablesReference: scopes[0].variablesReference });
    const pc = regs.variables.find((v) => v.name === "PC");
    assert.match(pc.value, /&1911 \(again\+3\)/);

    // Zero page counter is 0 the first time round.
    const ev = await dap.request("evaluate", { expression: "?counter", context: "watch" });
    assert.match(ev.result, /^&00 /);

    const mem = await dap.request("readMemory", { memoryReference: "0x1900", count: 4 });
    assert.deepEqual([...Buffer.from(mem.data, "base64")], [0xa9, 0x16, 0x20, 0xee]);

    const dis = await dap.request("disassemble", { memoryReference: "0x1911", instructionOffset: -2, instructionCount: 5 });
    assert.deepEqual(
        dis.instructions.map((i) => i.address),
        ["0x190C", "0x190E", "0x1911", "0x1913", "0x1915"],
    );
    assert.equal(dis.instructions[1].symbol, "again");
    assert.match(dis.instructions[1].instruction, /JSR &191A\s+; print_message/);

    // Step one instruction: INC counter, then LDA counter.
    let since = dap.events.length;
    await dap.request("stepIn", { threadId: 1 });
    await dap.waitFor("stopped", { since });
    let top = (await dap.request("stackTrace", { threadId: 1 })).stackFrames[0];
    assert.equal(top.line, lineIs("LDA counter"));

    // A watchpoint on the counter: continue, and it stops after the next INC.
    const info = await dap.request("dataBreakpointInfo", { name: "counter" });
    assert.ok(info.dataId);
    await dap.request("setBreakpoints", { source: { path: src }, breakpoints: [] });
    await dap.request("setDataBreakpoints", { breakpoints: [{ dataId: info.dataId, accessType: "write" }] });
    since = dap.events.length;
    await dap.request("continue", { threadId: 1 });
    const watched = await dap.waitFor("stopped", { since });
    assert.equal(watched.body.reason, "data breakpoint");
    const counter = await dap.request("evaluate", { expression: "?counter", context: "watch" });
    assert.match(counter.result, /^&02 /);

    // Step out of nothing much: set a function breakpoint on print_message and step out of it.
    await dap.request("setDataBreakpoints", { breakpoints: [] });
    const fb = await dap.request("setFunctionBreakpoints", { breakpoints: [{ name: "print_message" }] });
    assert.equal(fb.breakpoints[0].verified, true);
    since = dap.events.length;
    await dap.request("continue", { threadId: 1 });
    await dap.waitFor("stopped", { since });
    top = (await dap.request("stackTrace", { threadId: 1 })).stackFrames;
    assert.equal(top[0].instructionPointerReference, "0x191A");
    assert.match(top[1].name, /JSR print_message/, "the caller's JSR is found on the stack");
    since = dap.events.length;
    await dap.request("stepOut", { threadId: 1 });
    await dap.waitFor("stopped", { since });
    top = (await dap.request("stackTrace", { threadId: 1 })).stackFrames;
    assert.equal(top[0].instructionPointerReference, "0x1911");

    await dap.request("setFunctionBreakpoints", { breakpoints: [] });
    await dap.request("disconnect", {});
});

test("DAP: a raw binary with stopOnEntry stops at its first instruction", async (t) => {
    const server = await startServer(["--paused"]);
    const dap = new DapClient(server.dapPort);
    t.after(async () => {
        dap.close();
        await server.stop();
    });
    const bin = path.join(Hello, "build", "raw-test.bin");
    fs.writeFileSync(bin, Buffer.from([0xa9, 0x41, 0x20, 0xee, 0xff, 0x60])); // LDA #'A': JSR OSWRCH: RTS
    t.after(() => fs.rmSync(bin, { force: true }));
    await dap.connect();
    await dap.request("initialize", { adapterID: "bbcmicro" });
    const launched = dap.request("launch", { program: bin, loadAddress: "&2000", stopOnEntry: true });
    await dap.waitFor("initialized", { since: 0 });
    await dap.request("configurationDone");
    await launched;
    const stopped = await dap.waitFor("stopped", { timeout: 30000 });
    assert.equal(stopped.body.reason, "entry");
    const top = (await dap.request("stackTrace", { threadId: 1 })).stackFrames[0];
    assert.equal(top.instructionPointerReference, "0x2000");
    // Step over the LDA, and once it has stopped, over the JSR to OSWRCH.
    let since = dap.events.length;
    await dap.request("next", { threadId: 1 });
    await dap.waitFor("stopped", { since });
    since = dap.events.length;
    await dap.request("next", { threadId: 1 });
    await dap.waitFor("stopped", { since });
    const after = (await dap.request("stackTrace", { threadId: 1 })).stackFrames[0];
    assert.equal(after.instructionPointerReference, "0x2005");
    await dap.request("disconnect", {});
});

test("DAP: the extension's own requests: speed, watchpoints, history and going back, server info, snapshots", async (t) => {
    const server = await startServer(["--paused"]);
    const dap = new DapClient(server.dapPort);
    t.after(async () => {
        dap.close();
        await server.stop();
    });
    await dap.connect();
    await dap.request("initialize", { adapterID: "bbcmicro", linesStartAt1: true });
    const launched = dap.request("launch", {
        program: path.join(Hello, "build/hello.ssd"),
        debugInfo: [path.join(Hello, "build/hello.labels"), path.join(Hello, "build/hello.lst")],
        source: src,
    });
    await dap.waitFor("initialized", { since: 0 });
    const bpLine = lineIs("INC counter");
    await dap.request("setBreakpoints", { source: { path: src }, breakpoints: [{ line: bpLine }] });
    await dap.request("configurationDone");
    await launched;
    await dap.waitFor("stopped", { timeout: 30000 });

    const info = await dap.request("serverInfo");
    assert.equal(info.name, "bbc_server");
    assert.equal(info.ports.dap, server.dapPort);

    assert.deepEqual(await dap.request("setSpeed", { multiplier: 0.5 }), { uncapped: false, multiplier: 0.5 });
    assert.deepEqual(await dap.request("setSpeed", { uncapped: true }), { uncapped: true, multiplier: 0.5 });
    assert.deepEqual(await dap.request("setSpeed", { multiplier: 1 }), { uncapped: false, multiplier: 1 });

    // A watchpoint on the counter, named by its symbol, that outlives nothing it should not.
    let body = await dap.request("setWatchpoint", { address: "counter", access: "write", onChange: true });
    assert.equal(body.watchpoints.length, 1);
    const w = body.watchpoints[0];
    assert.equal(w.address, 0x70);
    assert.equal(w.symbol, "counter");
    assert.equal(w.onWrite && !w.onRead && w.onChange && w.enabled, true);
    body = await dap.request("setWatchpoint", { id: w.id, enabled: false });
    assert.equal(body.watchpoints[0].enabled, false, "turned off, kept");
    assert.equal(body.watchpoints[0].address, 0x70, "the rest kept as it was");

    // Off, it does not stop the machine: the breakpoint is next.
    await dap.request("setBreakpoints", { source: { path: src }, breakpoints: [] });
    let since = dap.events.length;
    await dap.request("setWatchpoint", { id: w.id, enabled: true });
    await dap.request("continue", { threadId: 1 });
    const watched = await dap.waitFor("stopped", { since, timeout: 30000 });
    assert.equal(watched.body.reason, "data breakpoint");
    body = await dap.request("watchpoints");
    assert.equal(body.watchpoints[0].hits, 1);
    body = await dap.request("clearWatchpoint", {});
    assert.equal(body.watchpoints.length, 0);

    // Going back, and the history that says how far.
    let history = await dap.request("history");
    assert.equal(history.rewind, true);
    assert.equal(history.live, true);
    assert.ok(history.headCycle >= history.oldestCycle && history.cyclesPerFrame === 40000);
    since = dap.events.length;
    await dap.request("stepBackInto", { threadId: 1 });
    await dap.waitFor("stopped", { since });
    const rewound = await dap.waitFor("bbcRewind", { since });
    assert.equal(rewound.body.command, "stepBackInto");
    assert.equal(rewound.body.moved, true);
    assert.equal(rewound.body.inPast, true);
    history = await dap.request("history");
    assert.equal(history.live, false);
    assert.ok(history.positionCycle < history.headCycle);

    // Back to the INC from a source line, then to the write of the counter.
    since = dap.events.length;
    await dap.request("runBackToAddress", { source: { path: src }, line: bpLine });
    await dap.waitFor("bbcRewind", { since });
    let top = (await dap.request("stackTrace", { threadId: 1 })).stackFrames[0];
    assert.equal(top.instructionPointerReference, "0x1911");
    since = dap.events.length;
    await dap.request("runBackToWrite", { address: "counter" });
    const toWrite = await dap.waitFor("bbcRewind", { since });
    assert.equal(toWrite.body.command, "runBackToWrite");
    since = dap.events.length;
    await dap.request("returnToLive", { threadId: 1 });
    const live = await dap.waitFor("bbcRewind", { since });
    assert.equal(live.body.inPast, false);

    // A search that finds nothing says so, and leaves the machine where it was.
    since = dap.events.length;
    await dap.request("runBackToAddress", { address: "&3000" });
    const none = await dap.waitFor("bbcRewind", { since });
    assert.equal(none.body.moved, false);
    assert.match(none.body.message, /not reached/);

    const snap = path.join(Hello, "build", "dap-test.snapshot.json");
    t.after(() => fs.rmSync(snap, { force: true }));
    const saved = await dap.request("saveSnapshot", { path: snap });
    assert.equal(saved.path, snap);
    assert.ok(saved.bytes > 1000 && fs.existsSync(snap));

    const tape = await dap.request("tapeControl", {});
    assert.equal(tape.tape, null);
    await dap.request("disconnect", {});
});

test("DAP: the profile as the editor's heat map reads it", async (t) => {
    const server = await startServer(["--paused"]);
    const dap = new DapClient(server.dapPort);
    t.after(async () => {
        dap.close();
        await server.stop();
    });
    await dap.connect();
    await dap.request("initialize", { adapterID: "bbcmicro", linesStartAt1: true });
    const launched = dap.request("launch", {
        program: path.join(Hello, "build/hello.ssd"),
        debugInfo: [path.join(Hello, "build/hello.labels"), path.join(Hello, "build/hello.lst")],
        source: src,
    });
    await dap.waitFor("initialized", { since: 0 });
    const bpLine = lineIs("INC counter");
    await dap.request("setBreakpoints", { source: { path: src }, breakpoints: [{ line: bpLine }] });
    await dap.request("configurationDone");
    await launched;
    await dap.waitFor("stopped", { timeout: 30000 });

    let body = await dap.request("profile", { action: "start", idle: ["nonesuch"] });
    assert.equal(body.active, true);
    assert.deepEqual(body.unresolved, ["nonesuch"]);
    assert.equal(body.frame_cycles, 40000);
    // Round the loop once more: print_message, called from `again`.
    let since = dap.events.length;
    await dap.request("continue", { threadId: 1 });
    await dap.waitFor("stopped", { since, timeout: 30000 });
    body = await dap.request("profile", { action: "stop" });
    assert.equal(body.active, false);
    assert.ok(body.cycles > 0);

    const jsr = body.lines.find((l) => l.path === src && l.line === lineIs("JSR print_message"));
    assert.ok(jsr, "the JSR's line is in the report");
    assert.equal(jsr.hits, 1);
    assert.ok(jsr.calls_cycles > jsr.cycles, "a JSR's line carries what its call took");
    const routine = body.routines.find((r) => r.name === "print_message");
    assert.equal(routine.path, src);
    assert.equal(routine.line, lineIs("LDX #0"), "the routine's first instruction");
    const node = body.call_nodes.find((n) => n.name === "print_message");
    assert.ok(node && node.parent !== null && node.calls === 1);
    assert.equal(node.line, routine.line);
    assert.equal(body.call_nodes[0].parent, null);
    assert.ok(body.call_nodes.every((n) => n.parent === null || n.parent < n.id), "parents before children");
    assert.equal(body.call_nodes[0].cycles, body.cycles, "the root's total is everything");

    // Run free for a while: whole frames, and the worst of them kept in full.
    await dap.request("setBreakpoints", { source: { path: src }, breakpoints: [] });
    await dap.request("profile", { action: "start", idle: [] });
    since = dap.events.length;
    await dap.request("continue", { threadId: 1 });
    await new Promise((r) => setTimeout(r, 600));
    await dap.request("pause", { threadId: 1 });
    await dap.waitFor("stopped", { since });
    body = await dap.request("profile", { action: "get" });
    assert.ok(body.frames > 5, `${body.frames} frames`);
    assert.equal(body.periods.by, "frame");
    assert.ok(body.periods.count >= body.frames - 1);
    assert.equal(body.periods.strip.length, body.periods.count);
    const worst = body.periods.worst[0];
    assert.ok(worst.busy_cycles === body.periods.busiest_cycles);
    assert.ok(worst.nodes.length > 0 && worst.routines.length > 0);
    assert.equal(worst.nodes.reduce((n, [, c]) => n + c, 0), worst.cycles, "the period's time, node by node");

    // The editor's model of it: what the heat map paints and the tree lists.
    const { indexReport, reportKeyFor, lineLabel, rootGroups, periodReport, heatLevel } = require("../extension/profile_model.js");
    const model = indexReport(body);
    assert.equal(model.total, body.cycles);
    assert.ok(model.frames > 5);
    const key = reportKeyFor(model, src);
    assert.ok(key, "the source file is in the report");
    const loop = model.byFile.get(key).get(lineIs("JSR print_message"));
    assert.ok(loop && loop.share > 0 && heatLevel(loop.share) >= 0);
    assert.ok(model.callTree.nodes.length === body.call_nodes.length);
    assert.ok(rootGroups(model.callTree, "total").length > 0);
    const one = indexReport(periodReport(body, worst));
    assert.equal(one.total, worst.cycles);
    for (const [, stats] of model.byFile.get(key)) {
        const label = lineLabel(model, stats);
        if (label) assert.match(label, /cyc\/frame/);
    }
    await dap.request("disconnect", {});
});
