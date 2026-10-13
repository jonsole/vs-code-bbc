// How far back in its history the machine is, in words: the rewind status
// bar item's text. No vscode import, so it is tested from plain Node
// (tests/extension_models.test.mjs). The ZX Spectrum extension's
// rewind_model.js, counting a BBC Micro's 2MHz cycles instead of T-states.
//
// A few cycles back is best said as cycles, a few frames as frames, and
// anything longer as seconds.

'use strict';

// The BBC paints fifty frames a second.
const FRAMES_PER_SECOND = 50;

function formatCount(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/// "live", "137 cycles before live", "4.5 frames before live" or
/// "12.3 s before live".
function describeBehind(behindCycles, cyclesPerFrame) {
  if (!(behindCycles > 0)) {
    return 'live';
  }
  const frames = cyclesPerFrame > 0 ? behindCycles / cyclesPerFrame : 0;
  if (frames < 1) {
    const cycles = Math.round(behindCycles);
    return `${formatCount(cycles)} cycle${cycles === 1 ? '' : 's'} before live`;
  }
  if (frames < FRAMES_PER_SECOND) {
    return `${frames.toFixed(1)} frames before live`;
  }
  return `${(frames / FRAMES_PER_SECOND).toFixed(1)} s before live`;
}

/// The status bar item for a `history` response: undefined when there is
/// nothing to show (live, or a server without the request).
function statusFor(history) {
  if (!history || !history.rewind || history.live) {
    return undefined;
  }
  const behind = history.headCycle - history.positionCycle;
  const available = history.headCycle - history.oldestCycle;
  return {
    text: describeBehind(behind, history.cyclesPerFrame),
    // How far into the recorded history, for the tooltip.
    share: available > 0 ? behind / available : 0,
  };
}

module.exports = { describeBehind, statusFor, formatCount };
