// The extension's pieces that need no VS Code: how the server is started and
// how the screen stream is read, against a real server.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { startServer, tool, Root } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { serverCommand, parseReadyLine, claudeMcpAddCommand, mcpJson, listAdvertised, portsFromConfig } = require("../extension/server_launch.js");
const { FrameDecoder } = require("../extension/frame_decoder.js");

test("server command: VS Code's own runtime as Node, or the configured one", () => {
    const own = serverCommand({ extensionPath: "/ext", nodePath: "", execPath: "/vscode/code", ports: { dap: 1, http: 2 }, model: "Master", env: { A: "1" } });
    assert.equal(own.command, "/vscode/code");
    assert.equal(own.env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(own.env.A, "1");
    assert.deepEqual(own.args.slice(1), ["--dap-port", "1", "--http-port", "2", "--exit-with-parent", "--model", "Master"]);
    const node = serverCommand({ extensionPath: "/ext", nodePath: "/usr/bin/node", execPath: "/vscode/code", ports: { dap: 1, http: 2 }, env: {} });
    assert.equal(node.command, "/usr/bin/node");
    assert.equal(node.env.ELECTRON_RUN_AS_NODE, undefined);
});

test("ready line and MCP setup text", () => {
    assert.deepEqual(parseReadyLine('{"ready":true,"dapPort":4811}\nmore'), { ready: true, dapPort: 4811 });
    assert.equal(parseReadyLine("Loading OS"), null);
    assert.equal(claudeMcpAddCommand({ http: 8811 }), "claude mcp add --transport http bbc-micro http://127.0.0.1:8811/mcp");
    assert.deepEqual(mcpJson({ http: 8811 }), { mcpServers: { "bbc-micro": { type: "http", url: "http://127.0.0.1:8811/mcp" } } });
});

test("screen stream: whole frames, decoded to the picture get_screen shows", async (t) => {
    const server = await startServer();
    t.after(() => server.stop());
    await tool(server, "type_text", { text: 'PRINT "STREAM"' });
    const frames = [];
    await new Promise((resolve, reject) => {
        const decoder = new FrameDecoder((f) => {
            frames.push(f);
            if (frames.length === 3) {
                req.destroy();
                resolve();
            }
        });
        const req = http.get({ host: "127.0.0.1", port: server.httpPort, path: "/stream?fps=25" }, (res) => {
            // Feed it in awkward pieces, as TCP may.
            res.on("data", (chunk) => {
                for (let i = 0; i < chunk.length; i += 777) decoder.push(chunk.subarray(i, i + 777));
            });
        });
        req.on("error", (e) => (frames.length >= 3 ? resolve() : reject(e)));
    });
    const f = frames.at(-1);
    assert.equal(f.width, 896);
    assert.equal(f.height, 600);
    assert.ok(f.palette, "a BBC frame fits a palette");
    assert.equal(f.pixels.length, f.width * f.height);
    // Mode 7 text: white on black, so the palette has black and white at least.
    const colours = new Set();
    for (let i = 0; i < f.palette.length; i += 3) colours.add(f.palette.subarray(i, i + 3).join(","));
    assert.ok(colours.has("0,0,0") && colours.has("255,255,255"), [...colours].join(" "));
    assert.ok(frames[1].frame > frames[0].frame, "frame numbers advance while it runs");
});

test("package.json points at files that exist", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const pkg = JSON.parse(fs.readFileSync(path.join(Root, "package.json"), "utf8"));
    for (const p of [pkg.main, ...pkg.contributes.grammars.map((g) => g.path), ...pkg.contributes.languages.map((l) => l.configuration)]) {
        assert.ok(fs.existsSync(path.join(Root, p)), p);
    }
    const commands = new Set(pkg.contributes.commands.map((c) => c.command));
    const ext = fs.readFileSync(path.join(Root, "extension/extension.js"), "utf8");
    for (const c of commands) assert.ok(ext.includes(`'${c}'`), `${c} is registered`);
});

test("more than one emulator: ports in a launch configuration, and every running emulator found", async (t) => {
    assert.equal(portsFromConfig("auto"), "auto");
    assert.deepEqual(portsFromConfig({ dap: 4812, http: 8812 }), { dap: 4812, http: 8812 });
    assert.deepEqual(portsFromConfig({ http: 8812, other: 1 }), { http: 8812 });
    assert.equal(portsFromConfig(undefined), null);
    assert.equal(portsFromConfig({ dap: "x" }), null);

    // An emulator on free ports advertises the ports it got, and server_info says where.
    const server = await startServer([], { ports: 0 });
    t.after(() => server.stop());
    const info = await tool(server, "server_info");
    assert.equal(info.ports.http, server.httpPort);
    const mine = listAdvertised().find((e) => e.pid === server.child.pid);
    assert.ok(mine, "listed");
    assert.deepEqual(mine.ports, { dap: server.dapPort, http: server.httpPort });
    assert.match(info.advertised_at, new RegExp(`${server.child.pid}\\.json$`));
    await server.stop();
    assert.equal(listAdvertised().find((e) => e.pid === server.child.pid), undefined, "gone when it stops");
});
