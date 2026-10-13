// The emulator in the status bar: a "BBC Micro" item while one is running on
// the settings' ports, saying whose it is, and offering Stop, Restart, Show
// Screen of... and the log. As the ZX Spectrum extension's server_view.js
// has it.
//
// Not polled: every probe is a request the server answers for nothing. A
// server this window started reports its own start and exit; one started
// elsewhere is noticed when a session starts or ends, on the commands, and
// when the window comes back into focus.

'use strict';

const vscode = require('vscode');

let server; // the ServerManager on the settings' ports
let statusItem;
let state = 'stopped'; // stopped | starting | running (this window's) | external

async function refresh() {
  let next;
  if (server.starting) {
    next = 'starting';
  } else if (server.child) {
    next = 'running';
  } else {
    next = (await server.info()) ? 'external' : 'stopped';
  }
  show(next);
}

function show(next) {
  state = next;
  vscode.commands.executeCommand('setContext', 'bbcMicro.serverRunning', next === 'running' || next === 'external');
  if (next === 'stopped') {
    statusItem.hide();
    return;
  }
  const port = server.ports.http;
  statusItem.text = next === 'starting' ? '$(loading~spin) BBC Micro' : '$(vm-running) BBC Micro';
  statusItem.tooltip =
    next === 'starting'
      ? `Starting the BBC Micro emulator on port ${port}...`
      : next === 'running'
        ? `BBC Micro emulator on port ${port}, started by VS Code`
        : `BBC Micro emulator on port ${port}, started outside this window`;
  statusItem.show();
}

async function commandMenu() {
  await refresh();
  const running = state === 'running' || state === 'external';
  const items = running
    ? [
        { label: '$(debug-restart) Restart Emulator', command: 'bbcMicro.serverRestart' },
        { label: '$(debug-stop) Stop Emulator', command: 'bbcMicro.serverStop' },
        { label: '$(device-desktop) Show Screen of...', command: 'bbcMicro.showScreenOf' },
        { label: '$(plug) Copy MCP Setup for Claude Code...', command: 'bbcMicro.copyMcpSetup' },
        { label: '$(output) Show Emulator Log', command: 'bbcMicro.serverLog' },
      ]
    : [
        { label: '$(play) Start Emulator', command: 'bbcMicro.serverStart' },
        { label: '$(device-desktop) Show Screen of...', command: 'bbcMicro.showScreenOf' },
        { label: '$(output) Show Emulator Log', command: 'bbcMicro.serverLog' },
      ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: statusItem.tooltip || 'The BBC Micro emulator is not running' });
  if (pick) {
    vscode.commands.executeCommand(pick.command);
  }
}

function activateServerView(context, manager) {
  server = manager;
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'bbcMicro.serverMenu';
  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('bbcMicro.serverMenu', commandMenu),
    server.onDidChange(() => refresh()),
    vscode.debug.onDidStartDebugSession(() => refresh()),
    vscode.debug.onDidTerminateDebugSession(() => refresh()),
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) {
        refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('bbcMicro.server')) {
        refresh();
      }
    }),
  );
  refresh();
  return { refresh };
}

module.exports = { activateServerView };
