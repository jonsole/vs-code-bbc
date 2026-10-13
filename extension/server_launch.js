// The pure half of starting the emulator from the extension: what it is run
// with and told, and how to read its readiness line. No vscode API, so it is
// tested from plain Node (node --test tests/); server_manager.js does the
// starting, stopping and showing.

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const DEFAULT_PORTS = { dap: 4811, http: 8811 };

// The server is ES modules for Node 22 or later. VS Code's own runtime is
// such a Node when run with ELECTRON_RUN_AS_NODE, so nothing need be
// installed; the nodePath setting picks another.
function serverCommand({ extensionPath, nodePath, execPath, ports, model, env }) {
  const main = path.join(extensionPath, 'server', 'main.mjs');
  const args = [
    main,
    '--dap-port', String(ports.dap),
    '--http-port', String(ports.http),
    '--exit-with-parent',
  ];
  if (model) {
    args.push('--model', model);
  }
  const useOwn = !nodePath;
  return {
    command: useOwn ? execPath : nodePath,
    args,
    env: useOwn ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : { ...env },
  };
}

// The server's first line on stdout: {"ready":true,...} or {"ready":false,"error":...}.
function parseReadyLine(text) {
  const line = String(text).split(/\r?\n/)[0];
  try {
    const msg = JSON.parse(line);
    return typeof msg.ready === 'boolean' ? msg : null;
  } catch {
    return null;
  }
}

function mcpUrl(ports) {
  return `http://127.0.0.1:${ports.http}/mcp`;
}

function claudeMcpAddCommand(ports) {
  return `claude mcp add --transport http bbc-micro ${mcpUrl(ports)}`;
}

function mcpJson(ports) {
  return { mcpServers: { 'bbc-micro': { type: 'http', url: mcpUrl(ports) } } };
}

// Where running emulators advertise themselves (see server/registry.mjs).
const REGISTRY_DIR = path.join(os.tmpdir(), 'bbc-micro-emulators');

// Every emulator advertised on this machine whose process is still there.
function listAdvertised(dir = REGISTRY_DIR) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      process.kill(entry.pid, 0);
      out.push(entry);
    } catch (e) {
      // Unreadable, or its process has gone, when the file goes too: on
      // Windows a killed emulator cannot take it away itself, and its pid
      // may soon be another process's.
      if (e.code === 'ESRCH') {
        fs.rmSync(path.join(dir, n), { force: true });
      }
    }
  }
  return out.sort((a, b) => String(a.started).localeCompare(String(b.started)));
}

// A launch configuration's `ports`: "auto", explicit ports, or the settings' (null).
function portsFromConfig(ports) {
  if (ports === 'auto') {
    return 'auto';
  }
  if (ports && typeof ports === 'object') {
    const out = {};
    for (const k of ['dap', 'http']) {
      if (Number.isInteger(ports[k]) && ports[k] > 0 && ports[k] < 65536) {
        out[k] = ports[k];
      }
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}

module.exports = { DEFAULT_PORTS, serverCommand, parseReadyLine, mcpUrl, claudeMcpAddCommand, mcpJson, listAdvertised, portsFromConfig, REGISTRY_DIR };
