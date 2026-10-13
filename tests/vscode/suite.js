// Inside VS Code: launch the hello example under the debugger as a user
// would, and check what VS Code's own DAP client sees.
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const vscode = require('vscode');

const folder = () => vscode.workspace.workspaceFolders[0].uri.fsPath;

function waitFor(predicate, what, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      let v;
      try {
        v = predicate();
      } catch (e) {
        v = undefined;
      }
      if (v) {
        return resolve(v);
      }
      if (Date.now() - start > timeout) {
        return reject(new Error(`timed out waiting for ${what}`));
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

function mcpCall(port, name, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => resolve(JSON.parse(s)));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function run() {
  const config = vscode.workspace.getConfiguration('bbcMicro');
  const httpPort = Number(process.env.BBC_TEST_HTTP_PORT);
  await config.update('httpPort', httpPort, vscode.ConfigurationTarget.Global);
  await config.update('dapPort', Number(process.env.BBC_TEST_DAP_PORT), vscode.ConfigurationTarget.Global);

  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'bbc-micro-debug');
  assert.ok(ext, 'extension is installed');
  await ext.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const c of ['bbcMicro.showScreen', 'bbcMicro.runFile', 'bbcMicro.copyMcpSetup']) {
    assert.ok(commands.includes(c), c);
  }

  // A .6502 file is BeebAsm, and can take breakpoints.
  const src = path.join(folder(), 'hello.6502');
  const doc = await vscode.workspace.openTextDocument(src);
  assert.strictEqual(doc.languageId, 'beebasm');
  const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/);
  const bpLine = lines.findIndex((l) => l.trim() === 'INC counter'); // 0-based
  vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(bpLine, 0)))]);

  const stops = [];
  vscode.debug.registerDebugAdapterTrackerFactory('bbcmicro', {
    createDebugAdapterTracker: () => ({
      onDidSendMessage: (m) => {
        if (m.type === 'event' && m.event === 'stopped') {
          stops.push(m.body);
        }
      },
    }),
  });

  const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
    type: 'bbcmicro',
    request: 'launch',
    name: 'test',
    program: '${workspaceFolder}/build/hello.ssd',
    debugInfo: ['${workspaceFolder}/build/hello.labels', '${workspaceFolder}/build/hello.lst'],
    source: '${workspaceFolder}/hello.6502',
  });
  assert.ok(started, 'debugging started');
  const session = vscode.debug.activeDebugSession;
  await waitFor(() => stops.length, 'the breakpoint', 60000);
  assert.strictEqual(stops[0].reason, 'breakpoint');

  const trace = await session.customRequest('stackTrace', { threadId: 1 });
  assert.strictEqual(trace.stackFrames[0].line, bpLine + 1);
  assert.strictEqual(path.normalize(trace.stackFrames[0].source.path), path.normalize(src));

  // VS Code's own view of where it stopped: the editor shows the source line.
  await waitFor(() => vscode.debug.activeStackItem, 'the focused stack frame');

  // The same machine is on MCP while VS Code debugs it.
  const reply = await mcpCall(httpPort, 'evaluate', { expression: 'PC' });
  assert.match(reply.result.content[0].text, /6417/); // &1911

  // The screen panel opened by itself, and frames reach it.
  await waitFor(() => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === 'BBC Micro')), 'the screen panel');

  await session.customRequest('continue', { threadId: 1 });
  await waitFor(() => stops.length >= 2, 'the second stop');
  const counter = await session.customRequest('evaluate', { expression: '?counter', context: 'watch' });
  assert.match(counter.result, /^&01 /);

  if (process.env.BBC_TEST_SCREENSHOT) {
    // For looking at by eye: the whole window, stopped at the breakpoint with the screen panel open.
    await vscode.commands.executeCommand('workbench.action.splitEditorRight');
    await vscode.commands.executeCommand('bbcMicro.showScreen');
    await new Promise((r) => setTimeout(r, 2500));
    require('child_process').execSync(`import -window root ${JSON.stringify(process.env.BBC_TEST_SCREENSHOT)}`);
  }
  await vscode.debug.stopDebugging(session);
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  await vscode.commands.executeCommand('bbcMicro.serverStop');
  console.log(`BBC suite: passed (${stops.length} stops: ${stops.map((s) => s.reason).join(', ')})`);
}

module.exports = { run };
