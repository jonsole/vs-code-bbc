import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { startServer, mcp, tool, Hello } from "./helpers.mjs";

test("MCP: handshake, tools, load and drive a program", async (t) => {
    const server = await startServer();
    t.after(() => server.stop());

    const init = await mcp(server, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    const { tools } = (await mcp(server, "tools/list")).result;
    for (const name of ["load_program", "get_screen", "set_breakpoint", "step", "read_memory", "type_text"]) {
        assert.ok(tools.some((t) => t.name === name), name);
    }

    const loaded = await tool(server, "load_program", {
        path: path.join(Hello, "build/hello.ssd"),
        debug_info: [path.join(Hello, "build/hello.labels"), path.join(Hello, "build/hello.lst")],
        source: path.join(Hello, "hello.6502"),
        stop_at: "print_message",
    });
    assert.equal(loaded.stopped.reason, "entry");
    assert.match(loaded.stopped.at, /&191A \(print_message\)/);

    const regs = await tool(server, "get_registers");
    assert.match(regs.pc, /print_message/);

    const step = await tool(server, "step", { mode: "into", count: 2 });
    assert.match(step.instruction, /BEQ/);

    await tool(server, "set_breakpoint", { address: "again", condition: "?counter=3" });
    const run = await tool(server, "run", { wait_ms: 5000 });
    assert.match(run.stopped.reason, /breakpoint/);
    assert.equal((await tool(server, "evaluate", { expression: "?counter" })).value, 3);
    await tool(server, "clear_breakpoint", {});

    const mem = await tool(server, "read_memory", { address: "message", length: 5 });
    assert.match(mem, /^&1928  48 65 6C 6C 6F\s+Hello$/);

    await tool(server, "run");
    await new Promise((r) => setTimeout(r, 1500));
    const text = await tool(server, "get_screen_text");
    assert.equal((text.match(/Hello from BeebAsm, debugged in VS Code/g) ?? []).length, 5);

    await tool(server, "type_text", { text: "PRINT 6*7" });
    await new Promise((r) => setTimeout(r, 300));
    assert.match(await tool(server, "get_screen_text"), />PRINT 6\*7\n\s+42\n>/);

    const shot = await tool(server, "get_screen");
    assert.equal(shot[0].type, "image");
    assert.equal(Buffer.from(shot[0].data, "base64").subarray(1, 4).toString(), "PNG");
});
