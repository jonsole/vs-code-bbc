// The MCP server end to end, against a real server, the way an agent uses it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, mcp, tool, Hello } from "./helpers.mjs";

const helloDebug = {
    debug_info: [path.join(Hello, "build/hello.labels"), path.join(Hello, "build/hello.lst")],
    source: path.join(Hello, "hello.6502"),
};

test("MCP: handshake and tool list", async (t) => {
    const server = await startServer();
    t.after(() => server.stop());
    const init = await mcp(server, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.match(init.result.instructions, /no sessions/);
    const { tools } = (await mcp(server, "tools/list")).result;
    const names = new Set(tools.map((t) => t.name));
    for (const name of ["load_program", "run_basic", "run_until_prompt", "run_frames", "run_for_cycles", "get_screen", "keyboard_state", "save_state", "read_sound_state", "save_memory"]) {
        assert.ok(names.has(name), name);
    }
    const reset = tools.find((t) => t.name === "reset");
    assert.ok(reset.inputSchema.properties.model.enum.includes("Master"));
});

test("MCP: BASIC, typing and the printed output", async (t) => {
    const server = await startServer();
    t.after(() => server.stop());

    const run = (await mcp(server, "tools/call", { name: "run_basic", arguments: { source: '10 FOR I%=1 TO 3\n20 PRINT "LINE ";I%\n30 NEXT' } })).result.content;
    const result = JSON.parse(run[0].text);
    assert.equal(result.completed, true);
    assert.match(result.output, /LINE 1\nLINE 2\nLINE 3\n>$/);
    assert.equal(run[1].type, "image");

    // type_text then run_until_prompt: the output of just that command.
    await tool(server, "type_text", { text: "PRINT 6*7" });
    const prompt = await tool(server, "run_until_prompt");
    assert.equal(prompt.completed, true);
    assert.match(prompt.output, /PRINT 6\*7\n\s+42\n>$/);
    assert.doesNotMatch(prompt.output, /LINE/, "what earlier calls took is not repeated");

    const frames = await tool(server, "run_frames", { count: 3 });
    assert.equal(frames.completed, true);
    assert.equal(frames.frames_run, 3);
    const cycles = await tool(server, "run_for_cycles", { cycles: 10000 });
    assert.ok(cycles.cycles_run >= 10000 && cycles.cycles_run < 10010, String(cycles.cycles_run));

    const shot = (await mcp(server, "tools/call", { name: "get_screen", arguments: { scale: 2 } })).result.content;
    assert.ok(JSON.parse(shot[0].text).frame_count > 0);
    const png = Buffer.from(shot[1].data, "base64");
    assert.equal(png.readUInt32BE(16), 896 * 2, "width");
});

test("MCP: keys on the matrix by name and by number", async (t) => {
    const server = await startServer();
    t.after(() => server.stop());
    await tool(server, "run_until_prompt");

    const down = await tool(server, "key_down", { key: "X" });
    assert.deepEqual(down.pressed, [{ col: 2, row: 4, name: "X", internal: 66, inkey: -67 }]);
    assert.deepEqual((await tool(server, "keyboard_state")).held_keys.map((k) => k.name), ["X"]);
    // INKEY sees it as the program would.
    await tool(server, "key_up", { inkey: -67 });
    assert.deepEqual((await tool(server, "keyboard_state")).held_keys, []);

    await assert.rejects(tool(server, "key_down", { key: "NOSUCH" }), /Unknown key "NOSUCH".*COLON_STAR/);
    await assert.rejects(tool(server, "key_down", { key: "A", internal: 65 }), /exactly one/);

    // press_key holds it while frames run: the BBC types it, and each call hands back what that printed.
    const q = await tool(server, "press_key", { key: "Q", frames: 3 });
    assert.equal(q.output.trim(), "Q");
    const ret = await tool(server, "press_key", { key: "RETURN", frames: 3 });
    assert.match(ret.output, /Mistake/);
});

test("MCP: program, breakpoints, memory, states", async (t) => {
    const server = await startServer();
    t.after(() => server.stop());

    const loaded = await tool(server, "load_program", { path: path.join(Hello, "build/hello.ssd"), ...helloDebug, stop_at: "print_message" });
    assert.equal(loaded.stopped_reason, "entry");
    assert.match(loaded.registers.pc, /&191A \(print_message\)/);

    const step = await tool(server, "step", { mode: "into", count: 2 });
    assert.match(step.registers.instruction, /BEQ/);

    // A state taken here comes back exactly.
    const { state_id } = await tool(server, "save_state", { label: "at print_message" });
    assert.equal((await tool(server, "list_states"))[0].label, "at print_message");

    await tool(server, "set_breakpoint", { address: "again", condition: "?counter=3" });
    const run = await tool(server, "run", { wait_ms: 5000 });
    assert.equal(run.stopped_reason, "breakpoint");
    assert.equal((await tool(server, "evaluate", { expression: "?counter" })).value, 3);
    await tool(server, "clear_breakpoint", {});

    const restored = await tool(server, "restore_state", { state_id });
    assert.match(restored.registers.instruction, /BEQ/);
    assert.equal((await tool(server, "evaluate", { expression: "?counter" })).value, 0);
    await tool(server, "delete_state", { state_id });
    assert.deepEqual(await tool(server, "list_states"), []);

    // Watchpoints by set_breakpoint's type, as jsbeeb-mcp spells it.
    await tool(server, "set_breakpoint", { address: "counter", type: "write" });
    const watched = await tool(server, "run", { wait_ms: 5000 });
    assert.equal(watched.stopped_reason, "watchpoint");
    await tool(server, "clear_watchpoint", {});

    const mem = await tool(server, "read_memory", { address: "message", length: 5 });
    assert.match(mem, /^&1928  48 65 6C 6C 6F\s+\|Hello\|\npaging: \{"romsel":/);
    await tool(server, "write_memory", { address: "&70", data: [1, 2, 3] });
    assert.match(await tool(server, "read_memory", { address: "&70", length: 3 }), /^&0070  01 02 03/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbc-mcp-"));
    const saved = await tool(server, "save_memory", { address: "&1900", length: 4, path: path.join(dir, "code.bin") });
    assert.equal(saved.saved, 4);
    assert.deepEqual([...fs.readFileSync(path.join(dir, "code.bin"))], [0xa9, 0x16, 0x20, 0xee]);
});

test("MCP: the sound chip", async (t) => {
    const server = await startServer();
    t.after(() => server.stop());
    await tool(server, "run_until_prompt");
    await tool(server, "start_sound_capture");
    await tool(server, "type_text", { text: "SOUND 1,-15,53,10" });
    await tool(server, "run_frames", { count: 5 });
    const state = await tool(server, "read_sound_state");
    assert.equal(state.channels.length, 3);
    const log = await tool(server, "stop_sound_capture");
    assert.match(log, /writes:\n/);
    // The OS puts BASIC's channel 1 on the chip's tone channel 2.
    assert.match(log, /CH2 volume attenuation 0\n.*CH2 tone low 5\n.*CH2 tone high 29/, log);
});

test("MCP: printed output is a transcript; screen text is what the screen shows now", async (t) => {
    const server = await startServer();
    t.after(() => server.stop());
    for (const mode of [7, 1, 0]) {
        const source = `10 MODE ${mode}\n20 PRINT "GONE"\n30 CLS\n40 PRINT "Hello #_"\n50 COLOUR 129:COLOUR 0:PRINT "inverse"`;
        const run = (await mcp(server, "tools/call", { name: "run_basic", arguments: { source, screenshot: false } })).result.content;
        const { output } = JSON.parse(run[0].text);
        // In order, with each clear (MODE, CLS) a form feed: nothing printed before one mixes into what follows.
        assert.equal(output, "RUN\n\fGONE\n\fHello #_\ninverse\n>", `MODE ${mode} output`);
        // The screen as it is: what CLS took away is gone, inverse text reads.
        assert.equal(await tool(server, "get_screen_text"), "Hello #_\ninverse\n>", `MODE ${mode} screen`);
    }
    // A scrolled MODE 7 screen reads from where the scroll left the top.
    await mcp(server, "tools/call", { name: "run_basic", arguments: { source: '10 MODE 7\n20 FOR I%=1 TO 30:PRINT "row ";I%:NEXT', screenshot: false } });
    const rows = (await tool(server, "get_screen_text")).split("\n");
    assert.equal(rows.length, 25);
    assert.equal(rows.at(-2), "row 30");
    // A positioned print appears once in the output, without its coordinates.
    await tool(server, "type_text", { text: 'VDU 31,10,5:PRINT "X"' });
    const out = await tool(server, "run_until_prompt");
    assert.match(out.output, /VDU 31,10,5:PRINT "X"\nX\n>$/);
});
