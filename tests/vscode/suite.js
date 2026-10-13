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
  const config = vscode.workspace.getConfiguration('bbcMicro.server');
  const httpPort = Number(process.env.BBC_TEST_HTTP_PORT);
  await config.update('httpPort', httpPort, vscode.ConfigurationTarget.Global);
  await config.update('dapPort', Number(process.env.BBC_TEST_DAP_PORT), vscode.ConfigurationTarget.Global);

  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'bbc-micro-debug');
  assert.ok(ext, 'extension is installed');
  await ext.activate();
  const commands = await vscode.commands.getCommands(true);
  const declared = ext.packageJSON.contributes.commands.map((c) => c.command);
  for (const c of declared) {
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
  await waitFor(() => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === 'BBC Micro Screen')), 'the screen panel');

  await session.customRequest('continue', { threadId: 1 });
  await waitFor(() => stops.length >= 2, 'the second stop');
  const counter = await session.customRequest('evaluate', { expression: '?counter', context: 'watch' });
  assert.match(counter.result, /^&01 /);

  // The extension's own rewind buttons: Step Back Into goes back one
  // instruction, and Return to Live comes home.
  let stopsBefore = stops.length;
  await vscode.commands.executeCommand('bbcMicro.stepBackInto');
  await waitFor(() => stops.length > stopsBefore, 'the step back');
  assert.strictEqual((await session.customRequest('history', {})).live, false);
  stopsBefore = stops.length;
  await vscode.commands.executeCommand('bbcMicro.returnToLive');
  await waitFor(() => stops.length > stopsBefore, 'the return to live');
  assert.strictEqual((await session.customRequest('history', {})).live, true);

  // The speed the status bar shows is the one the emulator has.
  assert.deepStrictEqual(await session.customRequest('setSpeed', { multiplier: 0.5 }), { uncapped: false, multiplier: 0.5 });
  assert.deepStrictEqual(await session.customRequest('setSpeed', { multiplier: 1 }), { uncapped: false, multiplier: 1 });

  // A watchpoint the Watchpoints view lists.
  const watched = await session.customRequest('setWatchpoint', { address: 'counter', access: 'write', onChange: true });
  assert.strictEqual(watched.watchpoints[0].symbol, 'counter');

  if (process.env.BBC_TEST_SCREENSHOT) {
    // For looking at by eye: the whole window, stopped at the breakpoint with the screen panel open.
    await vscode.commands.executeCommand('workbench.action.splitEditorRight');
    await vscode.commands.executeCommand('bbcMicro.showScreen');
    await vscode.commands.executeCommand('workbench.view.debug');
    await new Promise((r) => setTimeout(r, 2500));
    const shot = process.env.BBC_TEST_SCREENSHOT;
    if (process.platform === 'win32') {
      // The primary screen, through .NET: Windows has no `import`.
      const ps =
        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ' +
        '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
        '$i = New-Object System.Drawing.Bitmap $b.Width, $b.Height; ' +
        '[System.Drawing.Graphics]::FromImage($i).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); ' +
        `$i.Save('${shot.replace(/'/g, "''")}')`;
      require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', ps]);
    } else {
      require('child_process').execSync(`import -window root ${JSON.stringify(shot)}`);
    }
  }
  await session.customRequest('clearWatchpoint', {});
  await vscode.debug.stopDebugging(session);
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);

  // A session on an emulator of its own: a second machine, on free ports,
  // shown in the screen panel while it is the active session, and gone when
  // the session ends.
  const { listAdvertised } = require(path.join(ext.extensionPath, 'extension', 'server_launch.js'));
  const before = new Set(listAdvertised().map((e) => e.pid));
  const ownStarted = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
    type: 'bbcmicro',
    request: 'attach',
    name: 'own emulator',
    ports: 'auto',
  });
  assert.ok(ownStarted, 'the second session started');
  const own = vscode.debug.activeDebugSession;
  const theirs = await waitFor(() => listAdvertised().find((e) => !before.has(e.pid)), 'a new emulator', 60000);
  assert.notStrictEqual(theirs.ports.http, httpPort);
  const info = await mcpCall(theirs.ports.http, 'server_info', {});
  assert.match(info.result.content[0].text, new RegExp(`"pid":\\s*${theirs.pid}\\b`));
  await waitFor(
    () => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label.includes(`on :${theirs.ports.http}`))),
    'the screen panel on the new emulator',
  ).catch((e) => {
    throw new Error(`${e.message}; tabs: ${vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label)).join(' | ')}`);
  });
  await vscode.debug.stopDebugging(own);
  await waitFor(() => !listAdvertised().some((e) => e.pid === theirs.pid), 'the new emulator to stop', 15000);
  await vscode.commands.executeCommand('bbcMicro.serverStop');
  console.log(`BBC suite: passed (${stops.length} stops: ${stops.map((s) => s.reason).join(', ')})`);
}

module.exports = { run };
