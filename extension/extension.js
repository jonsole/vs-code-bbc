// BBC Micro Debug: VS Code's side of the emulator.
//
// The emulator is a separate process (server/main.mjs, jsbeeb inside) that
// serves DAP and MCP itself, so this extension only has to start it, point
// VS Code's debugger and its MCP client at it, and show its screen.

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { ServerManager } = require('./server_manager');
const { ScreenPanel } = require('./screen_panel');
const { mcpUrl, claudeMcpAddCommand, mcpJson } = require('./server_launch');

const DEBUG_TYPE = 'bbcmicro';
const RUNNABLE = /\.(ssd|dsd|uef|bas)$/i;

let server;

function activate(context) {
  server = new ServerManager(context);
  context.subscriptions.push(server);

  // DAP: the emulator serves it on a TCP port, so the "adapter" is just that port.
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
      async createDebugAdapterDescriptor() {
        const ports = await server.ensure();
        return new vscode.DebugAdapterServer(ports.dap, '127.0.0.1');
      },
    }),
  );
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new ConfigurationProvider()));
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((s) => {
      if (s.type === DEBUG_TYPE && vscode.workspace.getConfiguration('bbcMicro').get('showScreenOnDebug', true)) {
        ScreenPanel.show(context, server);
      }
    }),
  );

  // MCP: offer the emulator to VS Code's own MCP client (agent mode), starting it on demand.
  if (vscode.lm && typeof vscode.lm.registerMcpServerDefinitionProvider === 'function' && vscode.McpHttpServerDefinition) {
    const changed = new vscode.EventEmitter();
    context.subscriptions.push(changed);
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('bbcMicro.httpPort')) {
          changed.fire();
        }
      }),
    );
    context.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider('bbcMicro.mcp', {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions() {
          return [new vscode.McpHttpServerDefinition('BBC Micro emulator', vscode.Uri.parse(mcpUrl(server.ports)))];
        },
        async resolveMcpServerDefinition(definition) {
          await server.ensure();
          return definition;
        },
      }),
    );
  }

  const command = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  command('bbcMicro.showScreen', async () => {
    ScreenPanel.show(context, server);
    try {
      await server.ensure();
    } catch (e) {
      vscode.window.showErrorMessage(e.message);
    }
  });

  command('bbcMicro.runFile', (uri) => startFile(uri, true));
  command('bbcMicro.debugFile', (uri) => startFile(uri, false));

  command('bbcMicro.typeText', async () => {
    const text = await vscode.window.showInputBox({
      prompt: 'Type at the BBC Micro (RETURN is pressed after it)',
      placeHolder: '*CAT   or   PRINT PAGE   or   CHAIN "GAME"',
    });
    if (text === undefined) {
      return;
    }
    await server.ensure();
    await server.request('/api/type', { text });
  });

  command('bbcMicro.serverStart', async () => {
    try {
      await server.ensure();
      vscode.window.setStatusBarMessage(`BBC Micro emulator running: MCP at ${mcpUrl(server.ports)}`, 5000);
    } catch (e) {
      vscode.window.showErrorMessage(e.message);
    }
  });
  command('bbcMicro.serverStop', () => server.stop());
  command('bbcMicro.serverRestart', async () => {
    try {
      await server.restart();
    } catch (e) {
      vscode.window.showErrorMessage(e.message);
    }
  });
  command('bbcMicro.serverLog', () => server.output.show());

  command('bbcMicro.copyMcpSetup', async () => {
    const ports = server.ports;
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Copy the `claude mcp add` command', id: 'cli', detail: claudeMcpAddCommand(ports) },
        { label: 'Add to this workspace\'s .mcp.json', id: 'json', detail: 'Claude Code picks it up when it opens the folder' },
        { label: 'Copy the MCP URL', id: 'url', detail: mcpUrl(ports) },
      ],
      { placeHolder: 'Connect an MCP client (Claude Code, say) to the BBC Micro emulator' },
    );
    if (!choice) {
      return;
    }
    if (choice.id === 'cli') {
      await vscode.env.clipboard.writeText(claudeMcpAddCommand(ports));
      vscode.window.showInformationMessage('Copied. Run it in a terminal; the emulator must be running for the client to connect.');
    } else if (choice.id === 'url') {
      await vscode.env.clipboard.writeText(mcpUrl(ports));
    } else {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showErrorMessage('Open a folder first.');
        return;
      }
      const file = path.join(folder.uri.fsPath, '.mcp.json');
      let current = {};
      try {
        current = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // none yet, or not JSON: start afresh only if it does not exist
        if (fs.existsSync(file)) {
          vscode.window.showErrorMessage(`${file} is not valid JSON; not changing it.`);
          return;
        }
      }
      current.mcpServers = { ...(current.mcpServers ?? {}), ...mcpJson(ports).mcpServers };
      fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
      vscode.window.showTextDocument(vscode.Uri.file(file));
    }
  });

  // Start the emulator in the background so the screen and MCP are there when wanted.
  if (vscode.workspace.workspaceFolders?.some((f) => hasBbcLaunch(f.uri.fsPath))) {
    server.ensure().catch((e) => server.log(e.message));
  }
}

function hasBbcLaunch(folder) {
  try {
    return fs.readFileSync(path.join(folder, '.vscode', 'launch.json'), 'utf8').includes(`"${DEBUG_TYPE}"`);
  } catch {
    return false;
  }
}

async function startFile(uri, noDebug) {
  const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!file || !RUNNABLE.test(file)) {
    vscode.window.showErrorMessage('Pick a disc (.ssd, .dsd), tape (.uef) or BASIC (.bas) file to run.');
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  await vscode.debug.startDebugging(
    folder,
    { type: DEBUG_TYPE, request: 'launch', name: path.basename(file), program: file },
    { noDebug },
  );
}

class ConfigurationProvider {
  // F5 with no launch.json: run whatever runnable file is open.
  resolveDebugConfiguration(folder, config) {
    if (!config.type && !config.request && !config.name) {
      const file = vscode.window.activeTextEditor?.document.uri.fsPath;
      if (file && RUNNABLE.test(file)) {
        return { type: DEBUG_TYPE, request: 'launch', name: path.basename(file), program: file, cwd: folder?.uri.fsPath };
      }
      vscode.window.showInformationMessage('Add a BBC Micro configuration to launch.json to say what to run (Run > Add Configuration…).');
      return undefined;
    }
    if (config.request === 'launch' && !config.program && config.program !== '') {
      const file = vscode.window.activeTextEditor?.document.uri.fsPath;
      if (file && RUNNABLE.test(file)) {
        config.program = file;
      }
    }
    config.cwd = config.cwd ?? folder?.uri.fsPath;
    return config;
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
