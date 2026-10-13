// Watchpoints in the editor: the Watch Address command, and the list of what
// is being watched in the debug sidebar. As the ZX Spectrum extension's
// watchpoint_view.js has them.
//
// VS Code has watchpoints of its own -- data breakpoints, set from the memory
// inspector's "Break on Value Change" and shown in the BREAKPOINTS pane -- and
// the adapter answers those (dataBreakpointInfo/setDataBreakpoints). They only
// reach as far as VS Code's own UI goes, though: a watchpoint on a symbol, on
// a range, or one set over MCP has nowhere to appear there. Hence this view,
// which shows what the EMULATOR is watching, whoever asked for it.

'use strict';

const vscode = require('vscode');
const { watchpointName, watchpointDetail, parseWatchRequest } = require('./watchpoint_model');

let getSession;
let provider;
let view;
let refreshTimer;

class WatchpointTreeProvider {
  constructor() {
    this.watchpoints = [];
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  set(watchpoints) {
    this.watchpoints = watchpoints || [];
    this.emitter.fire();
  }

  getChildren() {
    return this.watchpoints;
  }

  /// Flat: every watchpoint is a root. Needed for reveal() to be allowed.
  getParent() {
    return undefined;
  }

  getTreeItem(w) {
    const item = new vscode.TreeItem(watchpointName(w), vscode.TreeItemCollapsibleState.None);
    item.description = watchpointDetail(w);
    item.id = String(w.id);
    item.contextValue = 'bbcWatchpoint';
    item.iconPath = new vscode.ThemeIcon(w.enabled ? 'eye' : 'eye-closed');
    item.tooltip = new vscode.MarkdownString(
      `**${watchpointName(w)}** — ${watchpointDetail(w)}\n\n` +
        (w.owner === 'mcp' ? 'Set by an MCP client. ' : '') +
        'The machine stops at the instruction after the access, and says what changed and ' +
        'what changed it. Step back once to be just before it.',
    );
    return item;
  }
}

function activateWatchpoints(context, sessionGetter) {
  getSession = sessionGetter;
  provider = new WatchpointTreeProvider();
  view = vscode.window.createTreeView('bbcMicroWatchpoints', { treeDataProvider: provider });
  context.subscriptions.push(view);

  context.subscriptions.push(vscode.commands.registerCommand('bbcMicro.watchAddress', watchAddress));
  context.subscriptions.push(
    vscode.commands.registerCommand('bbcMicro.clearWatchpoint', (item) => send('clearWatchpoint', { id: item && item.id ? item.id : 0 })),
  );
  context.subscriptions.push(vscode.commands.registerCommand('bbcMicro.clearWatchpoints', () => send('clearWatchpoint', {})));
  context.subscriptions.push(
    vscode.commands.registerCommand('bbcMicro.toggleWatchpoint', (item) => send('setWatchpoint', { id: item.id, enabled: !item.enabled })),
  );

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('bbcmicro', {
      createDebugAdapterTracker() {
        return {
          onDidSendMessage(message) {
            // A hit changes a count, and a session that has just started has
            // whatever the last one left the emulator watching.
            if (message && message.type === 'event' && message.event === 'stopped') {
              scheduleRefresh();
            }
          },
        };
      },
    }),
  );
  context.subscriptions.push(vscode.debug.onDidChangeActiveDebugSession(() => scheduleRefresh()));
  context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => show(undefined)));
}

async function send(request, args) {
  const session = getSession();
  if (!session) {
    vscode.window.showWarningMessage('No BBC Micro debug session is running.');
    return;
  }
  try {
    const body = await session.customRequest(request, args);
    show(body);
  } catch (err) {
    vscode.window.showWarningMessage(`BBC Micro: ${err.message || err}`);
  }
}

async function watchAddress() {
  // The word under the cursor is usually the label of the thing in question.
  let suggestion = '';
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const range = editor.selection.isEmpty
      ? editor.document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_.][\w.]*/)
      : editor.selection;
    if (range) {
      suggestion = editor.document.getText(range);
    }
  }
  const typed = await vscode.window.showInputBox({
    title: 'Watch Address',
    prompt: 'Address or symbol to watch, and how many bytes: "counter", "counter 8", "&3000,2", "4:&8000" for sideways bank 4',
    value: suggestion,
  });
  const request = parseWatchRequest(typed);
  if (!request) {
    return;
  }
  const access = await vscode.window.showQuickPick(
    [
      { label: 'Writes that change it', description: 'stop when the program writes a different value', access: 'write', onChange: true },
      { label: 'Every write', description: 'including a write of the value already there', access: 'write', onChange: false },
      { label: 'Reads', description: 'stop when the program reads it as data', access: 'read' },
      { label: 'Reads and writes', description: 'either', access: 'readWrite', onChange: false },
    ],
    { title: `Watch ${request.address}`, placeHolder: 'What to stop on' },
  );
  if (!access) {
    return;
  }
  await send('setWatchpoint', {
    address: request.address,
    length: request.length,
    access: access.access,
    onChange: access.onChange !== false,
  });
  // The list is in the debug sidebar; show it rather than leaving someone to
  // wonder whether the watchpoint took.
  if (view && provider.watchpoints.length > 0) {
    view.reveal(provider.watchpoints[provider.watchpoints.length - 1], { focus: false });
  }
}

function scheduleRefresh() {
  if (refreshTimer) {
    return;
  }
  refreshTimer = setTimeout(async () => {
    refreshTimer = undefined;
    const session = getSession();
    if (!session) {
      show(undefined);
      return;
    }
    try {
      show(await session.customRequest('watchpoints', {}));
    } catch {
      show(undefined); // an older server without the request
    }
  }, 100);
}

function show(body) {
  const watchpoints = (body && body.watchpoints) || [];
  provider.set(watchpoints);
  vscode.commands.executeCommand('setContext', 'bbcMicro.hasWatchpoints', watchpoints.length > 0);
}

module.exports = { activateWatchpoints };
