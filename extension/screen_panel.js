// The screen panel: the emulator's display, live, with the BBC's keyboard.
//
// The extension host reads the server's frame stream (it can reach
// 127.0.0.1; a webview cannot be relied on to), inflates each frame and
// posts it to the page, which paints it. Keys pressed in the panel go back
// the other way, by their KeyboardEvent.code, to the server's /api/key.
// With Sound on, the server's /audio stream is passed to the page the same
// way, which plays it.

'use strict';

const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { FrameDecoder } = require('./frame_decoder');

class ScreenPanel {
  // The panel that follows the active debug session; others are pinned to one emulator.
  static current = null;

  static show(context, server) {
    if (ScreenPanel.current) {
      ScreenPanel.current.setServer(server);
      ScreenPanel.current.panel.reveal(undefined, true);
      return ScreenPanel.current;
    }
    ScreenPanel.current = new ScreenPanel(context, server);
    return ScreenPanel.current;
  }

  /** A second panel, on one emulator until it is closed. */
  static showPinned(context, server) {
    return new ScreenPanel(context, server, { pinned: true });
  }

  constructor(context, server, { pinned = false } = {}) {
    this.context = context;
    this.server = server;
    this.pinned = pinned;
    this.disposed = false;
    this.request = null;
    this.retry = null;
    this.audioRequest = null;
    this.soundOn = false;
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
    this.serverWatch = server.onDidChange(() => this._changed());
    this._title();
    this.configWatch = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('bbcMicro.screenScale')) {
        this._post({ type: 'scale', scale: this._scale() });
      }
    });
    this._connect();
  }

  /** Show another emulator's screen, as the active debug session changes. */
  setServer(server) {
    if (!server || server === this.server || this.disposed) {
      return;
    }
    this.serverWatch.dispose();
    this.server = server;
    this.serverWatch = server.onDidChange(() => this._changed());
    this._changed();
  }

  _changed() {
    this._title();
    this._connect();
  }

  /** "BBC Micro", or with the program and port when it is not the usual emulator. */
  async _title() {
    const server = this.server;
    if (!server.located) {
      this.panel.title = 'BBC Micro (starting)';
      return;
    }
    if (!server.where) {
      this.panel.title = 'BBC Micro';
      return;
    }
    this.panel.title = `BBC Micro ${server.where}`;
    const info = await server.info();
    if (info && this.server === server && !this.disposed) {
      const name = info.program ? path.basename(String(info.program)) : info.model;
      this.panel.title = `BBC Micro — ${name} ${server.where}`;
    }
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
    if (!this.server.located) {
      return; // until it has started and has ports: its onDidChange says so
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
    if (this.soundOn) {
      this._connectAudio();
    }
  }

  _connectAudio() {
    this._stopAudio();
    if (this.disposed || !this.soundOn) {
      return;
    }
    let odd = null; // a byte of a sample split between chunks
    let pending = [];
    let pendingBytes = 0;
    const req = http.get({ host: '127.0.0.1', port: this.server.ports.http, path: '/audio' }, (res) => {
      res.on('data', (chunk) => {
        if (odd) {
          chunk = Buffer.concat([odd, chunk]);
          odd = null;
        }
        if (chunk.length & 1) {
          odd = chunk.subarray(chunk.length - 1);
          chunk = chunk.subarray(0, chunk.length - 1);
        }
        pending.push(chunk);
        pendingBytes += chunk.length;
        // About 20ms at a time: small enough to keep up, large enough to schedule.
        if (pendingBytes >= 1764) {
          const all = Buffer.concat(pending);
          pending = [];
          pendingBytes = 0;
          const pcm = new Int16Array(all.length / 2);
          for (let i = 0; i < pcm.length; i++) {
            pcm[i] = all.readInt16LE(i * 2);
          }
          this._post({ type: 'audio', pcm });
        }
      });
    });
    req.on('error', () => {});
    this.audioRequest = req;
  }

  _stopAudio() {
    if (this.audioRequest) {
      this.audioRequest.destroy();
      this.audioRequest = null;
    }
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
      case 'sound':
        this.soundOn = !!m.on;
        if (this.soundOn) {
          this._connectAudio();
        } else {
          this._stopAudio();
        }
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
    this._stopAudio();
    this.serverWatch.dispose();
    this.configWatch.dispose();
    if (ScreenPanel.current === this) {
      ScreenPanel.current = null;
    }
    this.panel.dispose();
  }
}

module.exports = { ScreenPanel };
