#!/usr/bin/env node
// bbc_server: one BBC Micro, served three ways.
//
//   DAP   TCP  127.0.0.1:4811   VS Code's debugger
//   HTTP       127.0.0.1:8811   /mcp     MCP (streamable HTTP) for AI agents
//                               /stream  the live screen, for VS Code's screen panel
//                               /audio   its sound, 16-bit mono at 44.1kHz
//                               /screen.png, /api/*  a screenshot and the panel's controls
//
// Usage: node server/main.mjs [--dap-port N] [--http-port N] [--host H]   (0: any free port)
//                             [--model B-DFS1.2] [--tube] [--warp] [--paused]
//                             [--program FILE [--load-address A] [--exec-address A]]
//                             [--ffmpeg PATH]
//
// Prints one JSON line {"ready":true,...} to stdout once it is listening, and
// logs to stderr. jsbeeb's own chatter (it logs with console.log) goes to
// stderr too, so stdout carries only that line.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Engine, PackageRoot } from "./engine.mjs";
import { startDapServer } from "./dap.mjs";
import { makeTools, handleMcp } from "./mcp.mjs";
import { serveStream } from "./screen_stream.mjs";
import { loadProgram } from "./program.mjs";
import { advertise } from "./registry.mjs";

const stdoutLog = console.log;
console.log = (...a) => console.error(...a);
console.info = console.log;

function parseArgs(argv) {
    const opts = { dapPort: 4811, httpPort: 8811, host: "127.0.0.1", model: "B-DFS1.2", warp: false, paused: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case "--dap-port":
                opts.dapPort = Number(next());
                break;
            case "--http-port":
            case "--mcp-port":
                opts.httpPort = Number(next());
                break;
            case "--host":
                opts.host = next();
                break;
            case "--model":
                opts.model = next();
                break;
            case "--warp":
                opts.warp = true;
                break;
            case "--tube":
                opts.tube = true;
                break;
            case "--paused":
                opts.paused = true;
                break;
            case "--program":
                opts.program = next();
                break;
            case "--load-address":
                opts.loadAddress = next();
                break;
            case "--exec-address":
                opts.execAddress = next();
                break;
            case "--ffmpeg":
                opts.ffmpeg = next();
                break;
            case "--exit-with-parent":
                opts.exitWithParent = true;
                break;
            case "-h":
            case "--help":
                stdoutLog(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 17).join("\n"));
                process.exit(0);
            default:
                console.error(`Unknown argument ${a}`);
                process.exit(2);
        }
    }
    return opts;
}

const log = (msg) => console.error(`[bbc] ${msg}`);
const opts = parseArgs(process.argv.slice(2));
const version = JSON.parse(fs.readFileSync(path.join(PackageRoot, "package.json"), "utf8")).version;
const jsbeebInfo = (() => {
    try {
        return /jsbeeb (\S+), commit `([0-9a-f]{7})/.exec(fs.readFileSync(path.join(PackageRoot, "vendor/jsbeeb/VENDORED.md"), "utf8"))?.slice(1).join(" ");
    } catch {
        return undefined;
    }
})();

const engine = new Engine({ model: opts.model, warp: opts.warp, tube: !!opts.tube });
await engine.init();
if (opts.ffmpeg) engine.ffmpegPath = opts.ffmpeg;
const started = new Date().toISOString();
let advertisedAt = null;

const serverInfo = () => ({
    name: "bbc_server",
    version,
    emulator: `jsbeeb ${jsbeebInfo ?? ""}`.trim(),
    model: engine.model.name,
    tube: engine.tube,
    pid: process.pid,
    started,
    ports: { dap: opts.dapPort, http: opts.httpPort },
    advertised_at: advertisedAt,
    mcp: `http://${opts.host}:${opts.httpPort}/mcp`,
    program: engine.programPath,
    debugInfo: engine.debugInfo.sources,
    running: engine.running,
});

const tools = makeTools(engine, serverInfo);

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function json(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

// The screen panel's controls: what the panel needs without a debug session.
const api = {
    key: (b) => (b.down ? engine.keyDown(b.code) : engine.keyUp(b.code)),
    releaseKeys: () => engine.releaseAllKeys(),
    type: (b) => {
        engine.type(b.text, { enter: b.enter !== false });
        if (!engine.running) engine.resume();
    },
    pause: () => engine.pause(),
    resume: () => engine.resume(),
    reset: async (b) => {
        await engine.reset({ hard: b.hard !== false });
        if (!engine.running) engine.resume();
    },
    warp: (b) => {
        engine.warp = !!b.on;
    },
    state: () => engine.state(),
    info: () => serverInfo(),
};

const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
        // Refuse cross-site browser requests: only local tools should drive the machine.
        const origin = req.headers.origin;
        if (origin && !/^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?|vscode-webview:\/\/.*)$/.test(origin)) {
            return json(res, 403, { error: "Forbidden origin" });
        }
        if (url.pathname === "/mcp") {
            if (req.method === "GET") {
                res.writeHead(405, { Allow: "POST" });
                return res.end();
            }
            if (req.method === "DELETE") {
                res.writeHead(200);
                return res.end();
            }
            if (req.method !== "POST") {
                res.writeHead(405);
                return res.end();
            }
            let message;
            try {
                message = JSON.parse(await readBody(req));
            } catch {
                return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
            }
            const reply = await handleMcp(tools, message, log);
            if (reply === null) {
                res.writeHead(202);
                return res.end();
            }
            return json(res, 200, reply);
        }
        if (url.pathname === "/stream") return serveStream(engine, req, res, { fps: Number(url.searchParams.get("fps") ?? 50) });
        if (url.pathname === "/audio") {
            // The sound, live, as 16-bit mono samples at 44.1kHz: only what is
            // made at real speed, since warp would be noise.
            res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
            res.socket?.setNoDelay(true);
            const off = engine.audio.listen((pcm) => {
                if (engine.warp || engine.speedMultiplier !== 1 || res.writableNeedDrain) return;
                res.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
            });
            req.on("close", off);
            res.on("error", off);
            return;
        }
        if (url.pathname === "/screen.png") {
            res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
            return res.end(engine.screenshotPng());
        }
        const m = /^\/api\/(\w+)$/.exec(url.pathname);
        if (m && api[m[1]]) {
            const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
            const result = await api[m[1]](body);
            return json(res, 200, result ?? { ok: true });
        }
        json(res, 404, { error: "Not found" });
    } catch (e) {
        log(`${url.pathname}: ${e.stack ?? e}`);
        if (!res.headersSent) json(res, 500, { error: e.message });
    }
});

try {
    const dap = await startDapServer(engine, { port: opts.dapPort, host: opts.host, log });
    await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(opts.httpPort, opts.host, resolve);
    });
    // Port 0 asks for any free port: from here on, the ones it got.
    opts.dapPort = dap.address().port;
    opts.httpPort = httpServer.address().port;
} catch (e) {
    console.error(`bbc_server: can't listen: ${e.message}`);
    stdoutLog(JSON.stringify({ ready: false, error: e.message, code: e.code }));
    process.exit(1);
}

if (opts.program) {
    const r = await loadProgram(engine, { program: opts.program, loadAddress: opts.loadAddress, execAddress: opts.execAddress });
    log(r.description);
    if (!r.stop && !opts.paused) engine.resume();
} else {
    await engine.bootToPrompt();
    if (!opts.paused) engine.resume();
}

advertisedAt = advertise({
    pid: process.pid,
    version,
    model: engine.model.name,
    ports: { dap: opts.dapPort, http: opts.httpPort },
    mcp: `http://${opts.host}:${opts.httpPort}/mcp`,
    started,
    cwd: process.cwd(),
});
log(`DAP on ${opts.host}:${opts.dapPort}, MCP on http://${opts.host}:${opts.httpPort}/mcp`);
stdoutLog(JSON.stringify({ ready: true, pid: process.pid, dapPort: opts.dapPort, httpPort: opts.httpPort, version }));

if (opts.exitWithParent) {
    // Started by VS Code: go when it does, even if it could not say goodbye.
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
    process.stdin.on("error", () => process.exit(0));
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
