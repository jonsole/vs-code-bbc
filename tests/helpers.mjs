// Start a real bbc_server on free ports and talk to it the way VS Code and an
// MCP client do: DAP over TCP, MCP over HTTP.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const Root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const Hello = path.join(Root, "examples", "hello");

async function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

/** A server on free ports; with `ports: 0`, it is asked to find them itself and the ready line says which. */
export async function startServer(extraArgs = [], { ports } = {}) {
    let dapPort = ports === 0 ? 0 : await freePort();
    let httpPort = ports === 0 ? 0 : await freePort();
    const child = spawn(process.execPath, [path.join(Root, "server", "main.mjs"), "--dap-port", dapPort, "--http-port", httpPort, ...extraArgs], {
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    await new Promise((resolve, reject) => {
        let out = "";
        child.stdout.on("data", (d) => {
            out += d;
            if (out.includes("\n")) {
                const msg = JSON.parse(out.split("\n")[0]);
                dapPort = msg.dapPort ?? dapPort;
                httpPort = msg.httpPort ?? httpPort;
                msg.ready ? resolve() : reject(new Error(msg.error));
            }
        });
        child.on("exit", (code) => reject(new Error(`server exited ${code}: ${stderr}`)));
    });
    return {
        dapPort,
        httpPort,
        child,
        stderr: () => stderr,
        // Killed on Windows, a child has a signalCode but no exitCode.
        stop: () => new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : (child.once("exit", r), child.kill()))),
    };
}

export async function mcp(server, method, params, id = 1) {
    const res = await fetch(`http://127.0.0.1:${server.httpPort}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return res.json();
}

/** Call a tool; returns its parsed JSON text, or the raw content for images. */
export async function tool(server, name, args = {}) {
    const r = await mcp(server, "tools/call", { name, arguments: args });
    if (r.error) throw new Error(r.error.message);
    const c = r.result.content[0];
    if (r.result.isError) throw new Error(c.text);
    if (c.type !== "text") return r.result.content;
    try {
        return JSON.parse(c.text);
    } catch {
        return c.text;
    }
}

export class DapClient {
    constructor(port) {
        this.port = port;
        this.seq = 1;
        this.pending = new Map();
        this.events = [];
        this.waiters = [];
        this.buffer = Buffer.alloc(0);
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.socket = net.connect(this.port, "127.0.0.1", resolve);
            this.socket.on("error", reject);
            this.socket.on("data", (d) => this._data(d));
        });
    }

    _data(d) {
        this.buffer = Buffer.concat([this.buffer, d]);
        for (;;) {
            const end = this.buffer.indexOf("\r\n\r\n");
            if (end < 0) return;
            const len = Number(/Content-Length: (\d+)/.exec(this.buffer.subarray(0, end).toString())[1]);
            if (this.buffer.length < end + 4 + len) return;
            const msg = JSON.parse(this.buffer.subarray(end + 4, end + 4 + len).toString());
            this.buffer = this.buffer.subarray(end + 4 + len);
            if (msg.type === "response") {
                const p = this.pending.get(msg.request_seq);
                this.pending.delete(msg.request_seq);
                msg.success ? p.resolve(msg.body ?? {}) : p.reject(new Error(msg.message));
            } else if (msg.type === "event") {
                this.events.push(msg);
                this.waiters = this.waiters.filter((w) => !(w.match(msg) && (w.resolve(msg), true)));
            }
        }
    }

    request(command, args = {}) {
        const seq = this.seq++;
        const body = Buffer.from(JSON.stringify({ seq, type: "request", command, arguments: args }));
        this.socket.write(`Content-Length: ${body.length}\r\n\r\n`);
        this.socket.write(body);
        return new Promise((resolve, reject) => this.pending.set(seq, { resolve, reject }));
    }

    /** The next event called `name` (after those already seen, unless `fromStart`). */
    waitFor(name, { timeout = 15000, since = this.events.length } = {}) {
        const earlier = this.events.slice(since).find((e) => e.event === name);
        if (earlier) {
            return Promise.resolve(earlier);
        }
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(`no ${name} event`)), timeout);
            this.waiters.push({ match: (m) => m.event === name, resolve: (m) => (clearTimeout(t), resolve(m)) });
        });
    }

    close() {
        this.socket.destroy();
    }
}
