// The screen panel: the emulator's display, live, with the BBC's keyboard.
//
// The extension host reads the server's frame stream (it can reach
// 127.0.0.1; a webview cannot be relied on to), inflates each frame and
// posts it to the page, which paints it. Keys pressed in the panel go back
// the other way, by their KeyboardEvent.code, to the server's /api/key.

'use strict';

const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { FrameDecoder } = require('./frame_decoder');

class ScreenPanel {
  static current = null;

  static show(context, server) {
    if (ScreenPanel.current) {
      ScreenPanel.current.panel.reveal(undefined, true);
      return ScreenPanel.current;
    }
    ScreenPanel.current = new ScreenPanel(context, server);
    return ScreenPanel.current;
  }

  constructor(context, server) {
    this.context = context;
    this.server = server;
    this.disposed = false;
    this.request = null;
    this.retry = null;
    this.panel = vscode.window.createWebviewPanel(
      'bbcMicro.screen',
      'BBC Micro',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    this.panel.iconPath = new vscode.ThemeIcon('device-desktop');
    this.panel.webview.html = this._html();
    this.panel.onDidDispose(() => this.dispose());
    this.panel.webview.onDidReceiveMessage((m) => this._onMessage(m));
    this.serverWatch = server.onDidChange(() => this._connect());
    this.configWatch = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('bbcMicro.screenScale')) {
        this._post({ type: 'scale', scale: this._scale() });
      }
    });
    this._connect();
  }

  _scale() {
    return vscode.workspace.getConfiguration('bbcMicro').get('screenScale', 'fit');
  }

  _html() {
    const nonce = Math.random().toString(36).slice(2);
    const file = path.join(this.context.extensionPath, 'extension', 'screen.html');
    return fs
      .readFileSync(file, 'utf8')
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{cspSource\}\}/g, this.panel.webview.cspSource)
      .replace(/\{\{scale\}\}/g, this._scale());
  }

  _post(message) {
    if (!this.disposed) {
      this.panel.webview.postMessage(message);
    }
  }

  _connect() {
    if (this.disposed) {
      return;
    }
    clearTimeout(this.retry);
    if (this.request) {
      this.request.destroy();
      this.request = null;
    }
    const decoder = new FrameDecoder((f) => this._post({ type: 'frame', ...f }));
    const req = http.get({ host: '127.0.0.1', port: this.server.ports.http, path: '/stream?fps=50' }, (res) => {
      this._post({ type: 'status', connected: true });
      res.on('data', (chunk) => decoder.push(chunk));
      res.on('end', () => this._lost());
      res.on('error', () => this._lost());
    });
    req.on('error', () => this._lost());
    this.request = req;
  }

  _lost() {
    if (this.disposed) {
      return;
    }
    this._post({ type: 'status', connected: false });
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this._connect(), 1000);
  }

  async _onMessage(m) {
    switch (m.type) {
      case 'key':
        await this.server.request('/api/key', { code: m.code, down: m.down });
        break;
      case 'releaseKeys':
        await this.server.request('/api/releaseKeys', {});
        break;
      case 'control':
        if (m.action === 'start') {
          try {
            await this.server.ensure();
          } catch (e) {
            vscode.window.showErrorMessage(e.message);
          }
        } else if (m.action === 'type') {
          vscode.commands.executeCommand('bbcMicro.typeText');
        } else {
          await this.server.request(`/api/${m.action}`, m.body ?? {});
        }
        break;
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearTimeout(this.retry);
    if (this.request) {
      this.request.destroy();
    }
    this.serverWatch.dispose();
    this.configWatch.dispose();
    ScreenPanel.current = null;
    this.panel.dispose();
  }
}

module.exports = { ScreenPanel };
