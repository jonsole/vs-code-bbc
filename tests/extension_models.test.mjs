// The extension's logic that needs no VS Code: the rewind status, the
// Watchpoints view's rows, and how big the screen panel draws the picture.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { describeBehind, statusFor } = require("../extension/rewind_model.js");
const { watchpointName, watchpointDetail, parseWatchRequest } = require("../extension/watchpoint_model.js");
const scaling = require("../extension/screen_scaling.js");
const { speedLabel } = (() => {
    // speed_view.js needs vscode for everything but this.
    const Module = require("node:module");
    const load = Module._load;
    Module._load = (req, ...a) => (req === "vscode" ? {} : load(req, ...a));
    try {
        return require("../extension/speed_view.js");
    } finally {
        Module._load = load;
    }
})();

test("rewind status: cycles, frames, then seconds before live", () => {
    assert.equal(describeBehind(0, 40000), "live");
    assert.equal(describeBehind(1, 40000), "1 cycle before live");
    assert.equal(describeBehind(12345, 40000), "12,345 cycles before live");
    assert.equal(describeBehind(180000, 40000), "4.5 frames before live");
    assert.equal(describeBehind(40000 * 50 * 12.3, 40000), "12.3 s before live");
    assert.equal(statusFor({ rewind: true, live: true }), undefined);
    assert.equal(statusFor(undefined), undefined);
    const s = statusFor({ rewind: true, live: false, oldestCycle: 0, headCycle: 400000, positionCycle: 300000, cyclesPerFrame: 40000 });
    assert.equal(s.text, "2.5 frames before live");
    assert.equal(s.share, 0.25);
});

test("watchpoints: rows in BBC notation, and what was typed read back", () => {
    const w = { id: 1, symbol: "counter", address: 0x70, length: 1, onWrite: true, onRead: false, onChange: true, test: "", enabled: true, hits: 0 };
    assert.equal(watchpointName(w), "counter (&0070)");
    assert.equal(watchpointDetail(w), "writes that change it");
    assert.equal(watchpointName({ ...w, symbol: "", address: 0x8000, bank: 4, length: 16 }), "4:&8000, 16 bytes");
    assert.equal(watchpointDetail({ ...w, onChange: false, onRead: true, hits: 2, enabled: false }), "every write and reads · 2 hits · off");
    assert.equal(watchpointDetail({ ...w, test: "=", value: 0 }), "writes of 0");
    assert.deepEqual(parseWatchRequest("counter"), { address: "counter", length: 1 });
    assert.deepEqual(parseWatchRequest("counter 8"), { address: "counter", length: 8 });
    assert.deepEqual(parseWatchRequest("&3000,2"), { address: "&3000", length: 2 });
    assert.deepEqual(parseWatchRequest("table + 4"), { address: "table + 4", length: 1 });
    assert.equal(parseWatchRequest("  "), undefined);
});

test("screen scaling: whole multiples of jsbeeb's 896x600 frame, in device pixels", () => {
    // A 1000x700 panel takes 1x; 1900x1300 takes 2x.
    assert.deepEqual(scaling.layoutFor("fit-integer", 1000, 700, 1), { canvasW: 896, canvasH: 600, cssW: 896, cssH: 600 });
    assert.deepEqual(scaling.layoutFor("fit-integer", 1900, 1300, 1), { canvasW: 1792, canvasH: 1200, cssW: 1792, cssH: 1200 });
    // ... and at 150% a 1000x700 panel is 1500x1050 device pixels: 1x still, in whole device pixels.
    assert.deepEqual(scaling.layoutFor("fit-integer", 1000, 700, 1.5), { canvasW: 896, canvasH: 600, cssW: 896 / 1.5, cssH: 400 });
    // Too small for 1x: no whole size, so it fits the panel.
    const small = scaling.layoutFor("fit-integer", 448, 700, 1);
    assert.deepEqual(small, { canvasW: 448, canvasH: 300, cssW: 448, cssH: 300 });
    const fit = scaling.layoutFor("fit", 1000, 700, 1);
    assert.equal(fit.canvasW, 1000, "the width is what limits it");
    assert.equal(fit.canvasH, Math.round(600 * (1000 / 896)));
    assert.deepEqual(scaling.layoutFor("2", 10, 10, 1), { canvasW: 1792, canvasH: 1200, cssW: 1792, cssH: 1200 });
    assert.equal(scaling.layoutFor("fit", 100, 100, 1).canvasW, 224, "no smaller than a quarter");
    assert.equal(scaling.prescaleFactor(896, 600, 896, 600), 1);
    assert.equal(scaling.prescaleFactor(1900, 1250, 896, 600), 2);
    assert.equal(scaling.prescaleFactor(700, 470, 896, 600), 0, "smaller than the frame: nothing to scale up");
    assert.equal(scaling.scanlinesPossible(1), false);
    assert.deepEqual(scaling.scanlineBand(2), { offset: 1, height: 1 });
    assert.deepEqual(scaling.scanlineBand(3), { offset: 2, height: 1 });
    assert.deepEqual(scaling.normaliseView({ filter: "x", scale: "9", scanlines: 140 }), { filter: "nearest", scale: "fit-integer", scanlines: 100 });
    // The page gets these as source text: each must stand alone.
    for (const f of [scaling.layoutFor, scaling.prescaleFactor, scaling.scanlinesPossible, scaling.scanlineBand]) {
        const alone = new Function(`${f.toString()}; return ${f.name};`)();
        assert.deepEqual(alone(...[896, 600, 896, 600]), f(896, 600, 896, 600));
    }
});

test("speed: the picker's own labels, and the number for anything else", () => {
    assert.equal(speedLabel({ uncapped: true, multiplier: 1 }), "Uncapped");
    assert.equal(speedLabel({ uncapped: false, multiplier: 0.25 }), "1/4x");
    assert.equal(speedLabel({ uncapped: false, multiplier: 0.3 }), "0.3x");
});

test("the screen page, as the panel assembles it, is a page whose script parses", async () => {
    const Module = require("node:module");
    const load = Module._load;
    const settings = { "bbcMicro.screen": { filter: "sharp-bilinear", scale: "fit", scanlines: 50 } };
    Module._load = (req, ...a) =>
        req === "vscode" ? { workspace: { getConfiguration: (s) => ({ get: (k) => settings[s]?.[k] }) } } : load(req, ...a);
    let ScreenPanel;
    try {
        ({ ScreenPanel } = require("../extension/screen_panel.js"));
    } finally {
        Module._load = load;
    }
    const { Root } = await import("./helpers.mjs");
    const fake = {
        context: { extensionPath: Root, globalState: { get: (k, d) => (k === "bbcMicro.audioVolume" ? 0 : d) } },
        panel: { webview: { cspSource: "vscode-webview:" } },
    };
    const html = ScreenPanel.prototype._html.call(fake);
    assert.doesNotMatch(html, /\{\{\w+\}\}/, "every placeholder filled");
    const script = /<script nonce="(\w+)">([\s\S]*)<\/script>/.exec(html);
    assert.ok(script, "the script carries its nonce");
    assert.match(html, new RegExp(`script-src 'nonce-${script[1]}'`));
    new Function("acquireVsCodeApi", "document", "window", "AudioContext", script[2]); // throws on a syntax error
    assert.match(script[2], /let view = \{"filter":"sharp-bilinear","scale":"fit","scanlines":50\};/);
    assert.match(script[2], /let volume = 0;/);
    assert.match(script[2], /let volumeBeforeMute = 100;/);
});
