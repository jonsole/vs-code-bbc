// Starting, adopting and stopping the emulator process.
//
// One emulator serves every window that wants it: if something already
// answers on the configured HTTP port, it is adopted rather than a second one
// started (and not stopped when this window goes). One this window started is
// tied to it: it reads its stdin from us and exits when that closes.

'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const http = require('http');
const { DEFAULT_PORTS, serverCommand, parseReadyLine } = require('./server_launch');

class ServerManager {
  constructor(context) {
    this.context = context;
    this.output = vscode.window.createOutputChannel('BBC Micro Emulator');
    this.child = null;
    this.starting = null;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }

  get ports() {
    const c = vscode.workspace.getConfiguration('bbcMicro');
    return { dap: c.get('dapPort', DEFAULT_PORTS.dap), http: c.get('httpPort', DEFAULT_PORTS.http) };
  }

  log(text) {
    this.output.appendLine(text);
  }

  /** GET a JSON endpoint on the server, or null if nothing answers. */
  request(pathname, body, timeoutMs = 1500) {
    return new Promise((resolve) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.ports.http,
          path: pathname,
          method: data ? 'POST' : 'GET',
          headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.end(data);
    });
  }

  async info() {
    return this.request('/api/info');
  }

  /** Make sure an emulator is listening; start one if not. Resolves to its ports. */
  async ensure() {
    if (await this.info()) {
      return this.ports;
    }
    if (!this.starting) {
      this.starting = this._start().finally(() => (this.starting = null));
    }
    await this.starting;
    return this.ports;
  }

  _start() {
    const config = vscode.workspace.getConfiguration('bbcMicro');
    const ports = this.ports;
    const { command, args, env } = serverCommand({
      extensionPath: this.context.extensionPath,
      nodePath: config.get('nodePath', ''),
      execPath: process.execPath,
      ports,
      model: config.get('model', ''),
      env: process.env,
    });
    this.log(`Starting: ${command} ${args.join(' ')}`);
    const child = cp.spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    child.stderr.on('data', (d) => this.output.append(d.toString()));
    child.on('exit', (code, signal) => {
      this.log(`Emulator exited (${signal ?? code})`);
      if (this.child === child) {
        this.child = null;
      }
      this._onDidChange.fire();
    });
    return new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('The emulator did not start within 30 seconds: see the BBC Micro Emulator output')), 30000);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`Can't run ${command}: ${e.message}`));
      });
      child.stdout.on('data', (d) => {
        out += d.toString();
        if (!out.includes('\n')) {
          return;
        }
        clearTimeout(timer);
        const ready = parseReadyLine(out);
        if (ready?.ready) {
          this.log(`Emulator ready: DAP on ${ready.dapPort}, MCP on http://127.0.0.1:${ready.httpPort}/mcp (pid ${ready.pid})`);
          this._onDidChange.fire();
          resolve(ready);
        } else {
          reject(new Error(`The emulator could not start: ${ready?.error ?? out.trim()}`));
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`The emulator exited (${code}) as it started: see the BBC Micro Emulator output`));
      });
    });
  }

  /** Stop the emulator this window started. One adopted from elsewhere is left alone. */
  async stop() {
    const child = this.child;
    if (!child) {
      if (await this.info()) {
        vscode.window.showInformationMessage('The running emulator was not started by this window, so it was left running.');
      }
      return false;
    }
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
      setTimeout(resolve, 3000);
    });
    return true;
  }

  async restart() {
    await this.stop();
    await this.ensure();
  }

  dispose() {
    if (this.child) {
      this.child.kill();
    }
    this.output.dispose();
    this._onDidChange.dispose();
  }
}

module.exports = { ServerManager };
