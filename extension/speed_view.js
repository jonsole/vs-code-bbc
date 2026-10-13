// The emulation speed: a debug toolbar button that opens a list of speeds,
// and a status bar item saying which is in use. As the ZX Spectrum extension
// has them.
//
// VS Code's debug toolbar takes buttons, not dropdowns, so "a dropdown" here
// is a button that opens a quick pick -- the same shape VS Code uses for
// every other list-of-choices in the debug UI. The status bar item beside it
// is what actually shows the current speed, since a toolbar button's title
// is fixed at contribution time and cannot.

'use strict';

const vscode = require('vscode');

const SPEED_CHOICES = [
  { label: '1/1000x', description: 'a frame every twenty seconds -- watch a single write land ahead of the beam', multiplier: 0.001 },
  { label: '1/500x', description: 'a frame every ten seconds', multiplier: 0.002 },
  { label: '1/200x', description: 'a frame every four seconds', multiplier: 0.005 },
  { label: '1/100x', description: 'a frame every two seconds -- the beam crawls down a few lines at a time', multiplier: 0.01 },
  { label: '1/50x', description: 'a frame a second -- raster effects line by line', multiplier: 0.02 },
  { label: '1/25x', description: 'two frames a second', multiplier: 0.04 },
  { label: '1/10x', description: 'slow motion -- slow enough to watch the beam sweep down the screen', multiplier: 0.1 },
  { label: '1/4x', description: 'quarter speed', multiplier: 0.25 },
  { label: '1/2x', description: 'half speed', multiplier: 0.5 },
  { label: '1x', description: 'a real 2MHz BBC Micro -- the only speed with sound', multiplier: 1 },
  { label: '2x', description: 'double speed', multiplier: 2 },
  { label: '3x', description: 'triple speed', multiplier: 3 },
  { label: '5x', description: 'five times -- for sitting through a tape load', multiplier: 5 },
  { label: 'Uncapped', description: 'as fast as this machine manages, with no pacing at all', uncapped: true },
];

let getSession;
let statusItem;
let current = { uncapped: false, multiplier: 1 };

/// How the current speed reads in the status bar: the picker's own label when
/// it is one of the offered speeds, and the bare number when the emulator was
/// set to something else (by an MCP client, say).
function speedLabel(speed) {
  if (speed.uncapped) {
    return 'Uncapped';
  }
  const known = SPEED_CHOICES.find((choice) => choice.multiplier === speed.multiplier);
  return known ? known.label : `${speed.multiplier}x`;
}

function refresh() {
  if (!getSession()) {
    statusItem.hide();
    return;
  }
  statusItem.text = `$(dashboard) ${speedLabel(current)}`;
  statusItem.tooltip = 'BBC Micro emulation speed -- click to change';
  statusItem.show();
}

/// Sends one speed change (or, with none, asks) and adopts whatever the
/// emulator reports back -- which is not always what was asked for, since
/// the multiplier is clamped.
async function apply(request, quiet) {
  const session = getSession();
  if (!session) {
    if (!quiet) {
      vscode.window.showErrorMessage('Start a BBC Micro debug session first.');
    }
    refresh();
    return;
  }
  try {
    const body = await session.customRequest('setSpeed', request);
    if (body) {
      current = { uncapped: body.uncapped === true, multiplier: body.multiplier };
    }
  } catch (err) {
    if (!quiet) {
      vscode.window.showErrorMessage(`Could not set the speed: ${err.message}`);
    }
  }
  refresh();
}

async function pickSpeed() {
  const choice = await vscode.window.showQuickPick(
    SPEED_CHOICES.map((entry) => ({ ...entry, label: speedLabel(current) === entry.label ? `$(check) ${entry.label}` : entry.label })),
    { title: 'BBC Micro: emulation speed' },
  );
  if (!choice) {
    return;
  }
  await apply(choice.uncapped ? { uncapped: true } : { multiplier: choice.multiplier });
}

function activateSpeed(context, sessionGetter) {
  getSession = sessionGetter;
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'bbcMicro.setSpeed';
  context.subscriptions.push(statusItem);
  context.subscriptions.push(vscode.commands.registerCommand('bbcMicro.setSpeed', pickSpeed));
  // A session can join an emulator that is already running at some other
  // speed, so it is asked rather than assumed.
  context.subscriptions.push(
    vscode.debug.onDidChangeActiveDebugSession(() => apply({}, true)),
    vscode.debug.onDidStartDebugSession(() => refresh()),
    vscode.debug.onDidTerminateDebugSession(() => setTimeout(refresh, 0)),
  );
}

module.exports = { activateSpeed, SPEED_CHOICES, speedLabel };
