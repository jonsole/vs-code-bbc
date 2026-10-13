// The screen panel: the emulator's display, live, with the BBC's keyboard and
// its sound. As the ZX Spectrum extension's screen panel is: the picture, a
// speaker button and volume slider in its corner, and the scaling and the
// machine's buttons in the panel's title bar.
//
// The extension host reads the server's frame stream (it can reach
// 127.0.0.1; a webview cannot be relied on to), inflates each frame and
// posts it to the page, which paints it. The server's /audio stream is
// passed to the page the same way, which plays it. Keys pressed in the panel
// go back the other way, by their KeyboardEvent.code, to the server's
// /api/key.

'use strict';

const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { FrameDecoder } = require('./frame_decoder');
const scaling = require('./screen_scaling');

const VIEW_TYPE = 'bbcMicroScreen';

// The panel's volume. 0 is mute, and the level before a mute is kept so the
// speaker button can go back to it. Both are kept across reloads, so a
// reload never turns the sound back up by itself.
const VOLUME_KEY = 'bbcMicro.audioVolume';
const VOLUME_BEFORE_MUTE_KEY = 'bbcMicro.audioVolumeBeforeMute';

// How the panel draws the picture, from the settings: see screen_scaling.js.
function screenView() {
  const config = vscode.workspace.getConfiguration('bbcMicro.screen');
  return scaling.normaliseView({ filter: config.get('filter'), scale: config.get('scale'), scanlines: config.get('scanlines') });
}

class ScreenPanel {
  // The panel that follows the active debug session; others are pinned to one emulator.
  static current = null;
  // Every open panel, and the one last in front: where the title bar's
  // buttons and the screen commands go.
  static all = new Set();
  static focused = null;

  static show(context, server) {
    if (ScreenPanel.current) {
      ScreenPanel.current.setServer(server);
      // Brought forward where it already is, never moved, and focus left in the editor.
      if (!ScreenPanel.current.panel.visible) {
        ScreenPanel.current.panel.reveal(ScreenPanel.current.panel.viewColumn, true);
      }
      return ScreenPanel.current;
    }
    ScreenPanel.current = new ScreenPanel(context, server);
    return ScreenPanel.current;
  }

  /** A second panel, on one emulator until it is closed. */
  static showPinned(context, server) {
    return new ScreenPanel(context, server, { pinned: true });
  }

  /** The panel a title-bar button or a screen command means: the one in front, else the following one. */
  static target() {
    return ScreenPanel.focused ?? ScreenPanel.current;
  }

  /** Every panel follows the settings, whoever changed them. */
  static viewChanged() {
    const view = screenView();
    for (const p of ScreenPanel.all) {
      p._post({ type: 'view', view });
    }
  }

  constructor(context, server, { pinned = false } = {}) {
    this.context = context;
    this.server = server;
    this.pinned = pinned;
    this.disposed = false;
    this.request = null;
    this.retry = null;
    this.audioRequest = null;
    this.audioRetry = null;
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'BBC Micro Screen',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    this.panel.iconPath = new vscode.ThemeIcon('device-desktop');
    this.panel.webview.html = this._html();
    this.panel.onDidDispose(() => this.dispose());
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        ScreenPanel.focused = this;
      }
    });
    this.panel.webview.onDidReceiveMessage((m) => this._onMessage(m));
    this.serverWatch = server.onDidChange(() => this._changed());
    ScreenPanel.all.add(this);
    ScreenPanel.focused = this;
    this._title();
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

  /** "BBC Micro Screen", or with the program and port when it is not the usual emulator. */
  async _title() {
    const server = this.server;
    if (!server.located) {
      this.panel.title = 'BBC Micro Screen (starting)';
      return;
    }
    if (!server.where) {
      this.panel.title = 'BBC Micro Screen';
      return;
    }
    this.panel.title = `BBC Micro Screen ${server.where}`;
    const info = await server.info();
    if (info && this.server === server && !this.disposed) {
      const name = info.program ? path.basename(String(info.program)) : info.model;
      this.panel.title = `BBC Micro Screen — ${name} ${server.where}`;
    }
  }

  _html() {
    const nonce = Math.random().toString(36).slice(2);
    const state = this.context.globalState;
    const volume = scaling.percent(state.get(VOLUME_KEY, 100), 100);
    const before = scaling.percent(state.get(VOLUME_BEFORE_MUTE_KEY, 100), 100) || 100;
    // The page draws with screen_scaling.js's own functions, as source.
    const fns = [scaling.layoutFor, scaling.prescaleFactor, scaling.scanlinesPossible, scaling.scanlineBand].map((f) => f.toString()).join('\n\n');
    const file = path.join(this.context.extensionPath, 'extension', 'screen.html');
    // A function as the replacement, so a "$" in what is put in is not a pattern.
    const values = { nonce, cspSource: this.panel.webview.cspSource, view: JSON.stringify(screenView()), volume: String(volume), volumeBeforeMute: String(before), scaling: fns };
    return fs.readFileSync(file, 'utf8').replace(/\{\{(\w+)\}\}/g, (all, name) => values[name] ?? all);
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
    // Only the current request's end counts: one destroyed by a reconnect
    // errors too, and taking that for a loss would reconnect again, and so
    // on every second.
    const lost = () => {
      if (this.request === req) {
        this._lost();
      }
    };
    const req = http.get({ host: '127.0.0.1', port: this.server.ports.http, path: '/stream?fps=50' }, (res) => {
      res.on('data', (chunk) => decoder.push(chunk));
      res.on('end', lost);
      res.on('error', lost);
    });
    req.on('error', lost);
    this.request = req;
    this._connectAudio();
  }

  _connectAudio() {
    this._stopAudio();
    if (this.disposed || !this.server.located) {
      return;
    }
    let odd = null; // a byte of a sample split between chunks
    let pending = [];
    let pendingBytes = 0;
    const lost = () => {
      if (this.audioRequest === req && !this.disposed) {
        this.audioRequest = null;
        this.audioRetry = setTimeout(() => this._connectAudio(), 1000);
      }
    };
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
      res.on('end', lost);
      res.on('error', lost);
    });
    req.on('error', lost);
    this.audioRequest = req;
  }

  _stopAudio() {
    clearTimeout(this.audioRetry);
    if (this.audioRequest) {
      const req = this.audioRequest;
      this.audioRequest = null;
      req.destroy();
    }
  }

  _lost() {
    if (this.disposed) {
      return;
    }
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
      case 'setVolume':
        // Stored when a drag ends rather than at every step of it.
        if (m.persist) {
          this.context.globalState.update(VOLUME_KEY, scaling.percent(m.volume, 100));
          this.context.globalState.update(VOLUME_BEFORE_MUTE_KEY, scaling.percent(m.before, 100) || 100);
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
    ScreenPanel.all.delete(this);
    if (ScreenPanel.current === this) {
      ScreenPanel.current = null;
    }
    if (ScreenPanel.focused === this) {
      ScreenPanel.focused = null;
    }
    this.panel.dispose();
  }
}

/// One list, three sections: picking a filter changes the filter, a size the
/// size, a scanline darkness the darkness, and the current one of each is
/// ticked. Stored as a user setting, so it holds in every workspace and
/// survives a reload.
async function pickScreenScaling() {
  const current = screenView();
  const items = [{ label: 'Filter', kind: vscode.QuickPickItemKind.Separator }];
  for (const f of scaling.FILTERS) {
    items.push({ label: `${f.id === current.filter ? '$(check)' : '$(blank)'} ${f.label}`, detail: f.detail, setting: 'filter', value: f.id });
  }
  items.push({ label: 'Size', kind: vscode.QuickPickItemKind.Separator });
  for (const s of scaling.SCALES) {
    items.push({ label: `${s.id === current.scale ? '$(check)' : '$(blank)'} ${s.label}`, detail: s.detail, setting: 'scale', value: s.id });
  }
  items.push({ label: 'Scanlines', kind: vscode.QuickPickItemKind.Separator });
  for (const percent of scaling.SCANLINE_PRESETS) {
    items.push({ label: `${percent === current.scanlines ? '$(check)' : '$(blank)'} ${percent === 0 ? 'Off' : `${percent}% dark`}`, setting: 'scanlines', value: percent });
  }
  const custom = !scaling.SCANLINE_PRESETS.includes(current.scanlines);
  items.push({
    label: `${custom ? '$(check)' : '$(blank)'} ${custom ? `Custom: ${current.scanlines}%` : 'Custom...'}`,
    detail: 'Any whole percentage from 0 to 100.',
    setting: 'scanlines',
    value: undefined,
  });
  const pick = await vscode.window.showQuickPick(items, {
    title: 'BBC Micro Screen Scaling',
    placeHolder: 'Pick a filter, a size or a scanline darkness -- each is set on its own',
  });
  if (!pick) {
    return;
  }
  let value = pick.value;
  if (value === undefined) {
    const typed = await vscode.window.showInputBox({
      title: 'Scanline darkness',
      prompt: 'How dark the gaps between the lines are, 0 (off) to 100 (black)',
      value: String(current.scanlines),
      validateInput: (text) => (/^\s*\d{1,3}\s*%?\s*$/.test(text) && Number(text.replace('%', '')) <= 100 ? undefined : 'A whole number from 0 to 100'),
    });
    if (typed === undefined) {
      return;
    }
    value = Number(typed.replace('%', '').trim());
  }
  await vscode.workspace.getConfiguration('bbcMicro.screen').update(pick.setting, value, vscode.ConfigurationTarget.Global);
}

module.exports = { ScreenPanel, pickScreenScaling, VIEW_TYPE };
