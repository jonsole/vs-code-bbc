// The MCP server end to end, against a real server, the way an agent uses it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, mcp, tool, Hello, DapClient } from "./helpers.mjs";

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
    for (const name of ["load_program", "run_basic", "run_until_prompt", "run_frames", "run_for_cycles", "get_screen", "keyboard_state", "save_state", "get_sound_state", "sound_capture", "save_memory"]) {
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
    const run = await tool(server, "run");
    assert.equal(run.stopped_reason, "breakpoint");
    assert.equal((await tool(server, "evaluate", { expression: "?counter" })).value, 3);
    await tool(server, "clear_breakpoint", {});

    const restored = await tool(server, "restore_state", { state_id });
    assert.match(restored.registers.instruction, /BEQ/);
    assert.equal((await tool(server, "evaluate", { expression: "?counter" })).value, 0);
    await tool(server, "delete_state", { state_id });
    assert.deepEqual(await tool(server, "list_states"), []);

    // A watchpoint says what changed, from what to what, and which instruction did it.
    await tool(server, "set_watchpoint", { address: "counter" });
    const watched = await tool(server, "run");
    assert.equal(watched.stopped_reason, "watchpoint");
    assert.deepEqual(watched.watch_stop, { watchpoint: watched.watch_stop.watchpoint, access: "write", address: "&0070 (counter)", old: "&00", new: "&01", by: "&1911 (again+3)" });
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
    await tool(server, "sound_capture", { action: "start" });
    await tool(server, "type_text", { text: "SOUND 1,-15,53,10" });
    await tool(server, "run_frames", { count: 5 });
    const state = await tool(server, "get_sound_state");
    assert.equal(state.channels.length, 3);
    const log = await tool(server, "sound_capture", { action: "stop" });
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

test("MCP: a run that nothing stops times out; on_change passes over a write of the same value", async (t) => {
    const server = await startServer();
    t.after(() => server.stop());
    await tool(server, "run_until_prompt");
    await tool(server, "write_memory", { address: "&70", data: [0] });
    // A tenth of a second's wait first, so RUN has been typed before the first write.
    await tool(server, "load_basic", { source: "10 T%=TIME:REPEAT UNTIL TIME>T%+10\n20 ?&70=5\n30 GOTO 20" });
    await tool(server, "type_text", { text: "RUN" });
    await tool(server, "set_watchpoint", { address: "&70" });
    // The first write changes 0 to 5, and stops...
    const first = await tool(server, "run", { timeout_secs: 2 });
    assert.equal(first.stopped_reason, "watchpoint");
    assert.equal(first.watch_stop.new, "&05");
    // ...every one after writes 5 over 5, which changes nothing: the run ends at its bound instead.
    const second = await tool(server, "run", { timeout_secs: 1 });
    assert.equal(second.completed, false);
    assert.equal(second.stopped_reason, "timeout");
    assert.ok(second.cycles_run >= 2000000 && second.cycles_run < 2100000, String(second.cycles_run));
    // Without on_change, every write stops it.
    await tool(server, "clear_watchpoint", {});
    await tool(server, "set_watchpoint", { address: "&70", on_change: false });
    assert.equal((await tool(server, "run", { timeout_secs: 2 })).stopped_reason, "watchpoint");
    await tool(server, "clear_watchpoint", {});
    // value: only a write of that byte.
    await tool(server, "set_watchpoint", { address: "&70", value: 6 });
    assert.equal((await tool(server, "run", { timeout_secs: 0.5 })).stopped_reason, "timeout");
    // wait: false leaves it running.
    assert.equal((await tool(server, "run", { wait: false })).running, true);
    await tool(server, "pause");
});

test("MCP: get_screen with frames gives a sequence, each tagged with its frame", async (t) => {
    const server = await startServer();
    t.after(() => server.stop());
    await tool(server, "run_until_prompt");
    const content = (await mcp(server, "tools/call", { name: "get_screen", arguments: { frames: 3, every: 2 } })).result.content;
    const tags = content.filter((c) => c.type === "text").map((c) => JSON.parse(c.text));
    assert.equal(content.filter((c) => c.type === "image").length, 3);
    assert.deepEqual(
        tags.map((x) => x.frame_count - tags[0].frame_count),
        [0, 2, 4],
    );
    assert.deepEqual(tags.map((x) => x.ms), [0, 40, 80]);
});

test("MCP: typed results, logpoint formats, and courtesy to a debugger on the same machine", async (t) => {
    const server = await startServer();
    t.after(() => server.stop());
    const { tools } = (await mcp(server, "tools/list")).result;
    assert.equal(tools.find((x) => x.name === "run_frames").outputSchema.required[0], "registers");

    // A result with a fixed shape comes as structuredContent as well as text.
    const r = (await mcp(server, "tools/call", { name: "run_until_prompt", arguments: {} })).result;
    assert.equal(r.structuredContent.completed, true);
    assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);

    // Logpoint formats: decimal, character, word, hex.
    await tool(server, "load_basic", { source: '10 A%=65:X%=7:CALL &900' });
    await tool(server, "write_memory", { address: "&900", data: "60" }); // RTS
    await tool(server, "set_breakpoint", { address: "&900", log_message: "A={A:d} chr={A:c} X={X} w={peekw(&900):w}" });
    await tool(server, "type_text", { text: "RUN" });
    await tool(server, "run_until_prompt");
    const log = await tool(server, "get_log");
    assert.equal(log.at(-1).text, "A=65 chr=A X=&07 w=&0060");

    // With a debugger attached, an agent's stop does not take its editor over,
    // and a tool that resets the machine says what it did.
    const dap = new DapClient(server.dapPort);
    await dap.connect();
    t.after(() => dap.close());
    await dap.request("initialize", { adapterID: "bbcmicro" });
    const before = dap.events.length;
    await tool(server, "step");
    const stopped = await dap.waitFor("stopped", { since: before });
    assert.equal(stopped.body.preserveFocusHint, true);
    const reset = await tool(server, "reset", {});
    assert.match(reset.warning, /VS Code is debugging/);
    // ...and a stop the debugger asks for is its own.
    let since = dap.events.length;
    await dap.request("pause", { threadId: 1 });
    const own = await dap.waitFor("stopped", { since });
    assert.equal(own.body.preserveFocusHint, false);
});

test("MCP: speed, breaking on interrupts, the tape recorder", async (t) => {
    const server = await startServer();
    t.after(() => server.stop());
    await tool(server, "run_until_prompt");

    // Each interrupt stops the run at its handler, saying where it came from.
    await tool(server, "set_break_on_interrupt", { enabled: true });
    const irq = await tool(server, "run", { timeout_secs: 1 });
    assert.equal(irq.stopped_reason, "interrupt");
    assert.match(irq.stopped, /^Interrupt: the handler at &[0-9A-F]{4}.*, from &[0-9A-F]{4}/);
    await tool(server, "set_break_on_interrupt", { enabled: false });

    // A tenth of real time: a tenth of a second of the machine's takes about a second.
    assert.deepEqual(await tool(server, "set_speed", { multiplier: 0.1 }), { speed: "realtime", multiplier: 0.1 });
    let start = Date.now();
    assert.equal((await tool(server, "run", { timeout_secs: 0.1 })).stopped_reason, "timeout");
    assert.ok(Date.now() - start > 700, `${Date.now() - start}ms`);
    // Uncapped: five seconds of it in well under five.
    await tool(server, "set_speed", { speed: "uncapped" });
    start = Date.now();
    await tool(server, "run", { timeout_secs: 5 });
    assert.ok(Date.now() - start < 4000, `${Date.now() - start}ms`);
    await tool(server, "set_speed", { speed: "realtime", multiplier: 1 });

    // The recorder, with a tape that is nothing but carrier tone.
    assert.equal((await tool(server, "tape_control")).tape, null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbc-tape-"));
    const uef = path.join(dir, "tone.uef");
    const chunk = Buffer.from([0x10, 0x01, 2, 0, 0, 0, 0xff, 0x7f]); // &0110: carrier tone, 32767 cycles
    fs.writeFileSync(uef, Buffer.concat([Buffer.from("UEF File!\0", "latin1"), Buffer.from([10, 0]), chunk]));
    await tool(server, "load_program", { path: uef, run: "*TAPE" });
    let status = await tool(server, "tape_control");
    assert.equal(status.tape, "tone.uef");
    assert.equal(status.play_pressed, true);
    status = await tool(server, "tape_control", { action: "stop" });
    assert.equal(status.play_pressed, false);
    assert.equal((await tool(server, "tape_control", { action: "eject" })).tape, null);
});

test("MCP: sideways banks: breakpoints, watchpoints and symbols for one bank", async (t) => {
    const server = await startServer();
    t.after(() => server.stop());
    await tool(server, "run_until_prompt");
    // Two sideways ROMs with different code at &8100: bank 4 stores &44 at &70, bank 5 &55 at &71.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbc-roms-"));
    for (const [bank, code] of [[4, [0xa9, 0x44, 0x85, 0x70, 0x60]], [5, [0xa9, 0x55, 0x85, 0x71, 0x60]]]) {
        const rom = Buffer.alloc(16384);
        Buffer.from(code).copy(rom, 0x100);
        fs.writeFileSync(path.join(dir, `bank${bank}.rom`), rom);
        const loaded = await tool(server, "load_rom", { path: path.join(dir, `bank${bank}.rom`), bank, reset: false });
        assert.equal(loaded.bank, bank);
    }
    // In RAM: page bank 4 in (and tell the MOS, at &F4), call &8100; the same with bank 5; round again.
    await tool(server, "pause");
    await tool(server, "write_memory", { address: "&2000", data: "A9 04 85 F4 8D 30 FE 20 00 81 A9 05 85 F4 8D 30 FE 20 00 81 4C 00 20" });
    await tool(server, "set_registers", { pc: "&2000" });
    // The ROM's symbols, as its own: they name bank 4's code and not bank 5's.
    const labels = path.join(dir, "rom.sym");
    fs.writeFileSync(labels, "store44 = &8100\n");
    await tool(server, "load_debug_info", { files: [labels], bank: 4 });

    assert.equal((await tool(server, "read_memory", { address: "5:&8100", length: 2 })).split("\n")[0].slice(0, 12), "&8100  A9 55");
    await tool(server, "set_breakpoint", { address: "5:&8100" });
    let stop = await tool(server, "run", { timeout_secs: 1 });
    assert.equal(stop.stopped_reason, "breakpoint");
    assert.equal(stop.registers.pc, "5:&8100");
    await tool(server, "clear_breakpoint", { address: "&8100", bank: 5 });
    await tool(server, "set_breakpoint", { address: "&8100", bank: 4 });
    stop = await tool(server, "run", { timeout_secs: 1 });
    assert.equal(stop.registers.pc, "4:&8100 (store44)");
    assert.deepEqual((await tool(server, "list_breakpoints")).map((b) => b.address), ["4:&8100 (store44)"]);
    await tool(server, "clear_breakpoint", {});

    // A watchpoint on bank 5's store, by the bank the store's instruction runs in.
    await tool(server, "write_memory", { address: "&71", data: [0] });
    await tool(server, "set_watchpoint", { address: "&71" });
    stop = await tool(server, "run", { timeout_secs: 1 });
    assert.equal(stop.watch_stop.by, "5:&8102");
    await tool(server, "clear_watchpoint", {});

    // set_paging pages a bank in as a debugger.
    assert.equal((await tool(server, "set_paging", { bank: 4 })).paging.romsel & 15, 4);
    await assert.rejects(tool(server, "set_breakpoint", { address: "4:&2000" }), /Only &8000-&BFFF is banked/);
    await assert.rejects(tool(server, "set_breakpoint", { address: "&8100", bank: 16 }), /0-15/);
});
