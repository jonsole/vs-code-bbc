// The DAP server end to end, as VS Code drives it: launch the hello example
// with its BeebAsm listing, stop at a source breakpoint, look around, step.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, DapClient, Hello } from "./helpers.mjs";

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
    // Step over the JSR to OSWRCH.
    await dap.request("next", { threadId: 1 });
    let since = dap.events.length;
    await dap.request("next", { threadId: 1 });
    await dap.waitFor("stopped", { since });
    const after = (await dap.request("stackTrace", { threadId: 1 })).stackFrames[0];
    assert.equal(after.instructionPointerReference, "0x2005");
    await dap.request("disconnect", {});
});
