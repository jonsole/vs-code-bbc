// Starting, adopting and stopping the emulator process.
//
// One emulator serves every window that wants it: if something already
// answers on the configured HTTP port, it is adopted rather than a second one
// started (and not stopped when this window goes). One this window started is
// tied to it: it reads its stdin from us and exits when that closes.
//
// A manager is for one emulator: the one on the settings' ports (the
// default), one on ports a launch configuration names, or, with "auto", a
// new one on free ports for one debug session.

'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const http = require('http');
const { DEFAULT_PORTS, serverCommand, parseReadyLine } = require('./server_launch');

class ServerManager {
  /**
   * @param {object} [opts]
   * @param {{dap?: number, http?: number}} [opts.ports] these ports, not the settings'
   * @param {boolean} [opts.auto] a new emulator on free ports, whatever is running
   * @param {vscode.OutputChannel} [opts.output] shared with the other managers
   */
  constructor(context, { ports, auto = false, output } = {}) {
    this.context = context;
    this.ownsOutput = !output;
    this.output = output ?? vscode.window.createOutputChannel('BBC Micro Emulator');
    this.fixedPorts = ports ?? null;
    this.auto = auto;
    this.child = null;
    this.starting = null;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }

  get ports() {
    const c = vscode.workspace.getConfiguration('bbcMicro.server');
    const settings = { dap: c.get('dapPort', DEFAULT_PORTS.dap), http: c.get('httpPort', DEFAULT_PORTS.http) };
    return { ...settings, ...(this.fixedPorts ?? {}) };
  }

  /** The emulator on the settings' ports, which the commands and MCP registration use. */
  get isDefault() {
    return !this.fixedPorts && !this.auto;
  }

  /** Whether its ports are known: an "auto" one's are not until it has started. */
  get located() {
    return !this.auto || !!this.fixedPorts;
  }

  /** "on :8811", or nothing for the default emulator: for titles. */
  get where() {
    return this.isDefault ? '' : `on :${this.ports.http}`;
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
    // "auto": its own, started the first time; not something else already there.
    if (!(this.auto && !this.child) && (await this.info())) {
      return this.ports;
    }
    // A start already under way is shared, but only if it is for these
    // ports: the settings can change while one starts (the window opened on
    // a folder with a launch configuration, and its ports were then set).
    const key = JSON.stringify(this.ports);
    if (this.starting && this.startingFor !== key && !this.auto) {
      await this.starting.catch(() => {});
      return this.ensure();
    }
    if (!this.starting) {
      this.startingFor = key;
      this.starting = this._start().finally(() => {
        this.starting = null;
        this._onDidChange.fire();
      });
      this._onDidChange.fire(); // starting: the status bar says so
    }
    await this.starting;
    return this.ports;
  }

  _start() {
    const config = vscode.workspace.getConfiguration('bbcMicro.server');
    const ports = this.auto ? { dap: 0, http: 0 } : this.ports;
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
        if (this.auto) {
          this.fixedPorts = null; // a restart gets new ports
        }
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
          if (this.auto) {
            this.fixedPorts = { dap: ready.dapPort, http: ready.httpPort };
          }
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

  /**
   * Stop the emulator: the one this window started, or after asking, one
   * adopted from elsewhere (another window, a terminal, an MCP client),
   * found by the pid it gives.
   */
  async stop({ ask = true } = {}) {
    const child = this.child;
    if (!child) {
      const info = await this.info();
      if (!info || !info.pid) {
        return false;
      }
      if (ask) {
        const choice = await vscode.window.showWarningMessage(
          `The BBC Micro emulator on port ${this.ports.http} (pid ${info.pid}) was not started by this window. Stop it anyway?`,
          { modal: true },
          'Stop It',
        );
        if (choice !== 'Stop It') {
          return false;
        }
      }
      try {
        process.kill(info.pid);
      } catch (e) {
        vscode.window.showErrorMessage(`Could not stop the emulator (pid ${info.pid}): ${e.message}`);
        return false;
      }
      for (let i = 0; i < 20 && (await this.info()); i++) {
        await new Promise((r) => setTimeout(r, 150));
      }
      this._onDidChange.fire();
      return true;
    }
    await new Promise((resolve) => {
      child.once('exit', resolve);
      endChild(child);
      setTimeout(resolve, 3000);
    });
    return true;
  }

  /** Stop it (asking first if it is not this window's) and start a fresh one. */
  async restart() {
    if ((this.child || (await this.info())) && !(await this.stop())) {
      return;
    }
    await this.ensure();
  }

  dispose() {
    if (this.child) {
      endChild(this.child);
    }
    if (this.ownsOutput) {
      this.output.dispose();
    }
    this._onDidChange.dispose();
  }
}

// Closing its stdin lets the emulator exit as it means to, taking its entry
// out of the registry; kill() alone does not on Windows, where it is
// TerminateProcess. It is killed if it has not gone in a second.
function endChild(child) {
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 1000);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
}

module.exports = { ServerManager };
