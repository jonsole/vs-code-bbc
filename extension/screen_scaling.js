// How big the screen panel draws the BBC's picture, and through which
// filter: the ZX Spectrum extension's screen_scaling.js, for a BBC frame. No
// vscode import, so it is tested from plain Node
// (tests/extension_models.test.mjs) -- and the functions are written to
// stand alone, with no outside names, because the webview needs them too and
// gets them as source text (see screen_panel.js).
//
// jsbeeb paints an 896x600 frame, border included: a pixel is a MODE 0
// pixel wide, and each of the BBC's 300 lines is two rows -- the same row
// twice in most modes, and the two fields of MODE 7's interlace, which is
// how teletext gets its smooth characters. So 1x is that frame, and there is
// no smaller whole size: halving it would lose MODE 0's columns and MODE 7's
// second field. A panel too small for 1x gets the frame scaled down smoothly,
// whatever the filter, since nearest neighbour could only drop rows there.
//
// Every size is worked out in DEVICE pixels first and only then turned back
// into CSS pixels: on a 150% display "1x" is one and a half device pixels a
// frame pixel, and a nearest-neighbour filter is only crisp when that number
// is whole.

'use strict';

/// The filters, in the order they are offered.
const FILTERS = [
  { id: 'nearest', label: 'Nearest neighbour', detail: 'Hard-edged pixels, as the video ULA drew them. Uneven at in-between sizes.' },
  { id: 'sharp-bilinear', label: 'Sharp bilinear', detail: 'Hard-edged pixels, evenly sized at any size: only their edges are blended.' },
  { id: 'bilinear', label: 'Bilinear', detail: 'Smoothed, as a television would soften it.' },
];

/// The sizes, in the order they are offered.
const SCALES = [
  { id: 'fit-integer', label: 'Fit, whole multiples', detail: 'As large as the panel allows in whole steps -- every pixel the same size.' },
  { id: 'fit', label: 'Fit', detail: 'Fill the panel, keeping the shape.' },
  { id: '1', label: '1x', detail: '896 x 600: jsbeeb\'s frame as it is' },
  { id: '2', label: '2x', detail: '1792 x 1200' },
];

/// The scanline darknesses offered in the picker, as percentages. Any whole
/// number from 0 to 100 works; these are the ones worth a click.
const SCANLINE_PRESETS = [0, 25, 50, 75, 100];

/// The canvas size for a scale setting, in a panel `availW` x `availH` CSS
/// pixels on a display with `dpr` device pixels to the CSS pixel, for a
/// `srcW` x `srcH` frame. `canvasW` and `canvasH` are the backing store, in
/// device pixels; `cssW` and `cssH` are what it is laid out at, so the two
/// map one to one and the browser never rescales the canvas behind the
/// filter's back.
function layoutFor(scale, availW, availH, dpr, srcW, srcH) {
  const NATIVE_W = srcW > 0 ? srcW : 896;
  const NATIVE_H = srcH > 0 ? srcH : 600;
  const ratio = dpr > 0 ? dpr : 1;
  // Device pixels per frame pixel, and what fits.
  const fits = Math.min((availW * ratio) / NATIVE_W, (availH * ratio) / NATIVE_H);
  let perPixel;
  if (scale === 'fit') {
    perPixel = fits;
  } else if (scale === '1' || scale === '2') {
    perPixel = Number(scale) * ratio;
  } else {
    // fit-integer, and anything unrecognised: the safe choice. Below 1x
    // there is no whole size, so it fits the panel.
    perPixel = fits >= 1 ? Math.floor(fits) : fits;
  }
  // A quarter is as small as it is worth going.
  if (!(perPixel >= 0.25)) {
    perPixel = 0.25;
  }
  const canvasW = Math.max(1, Math.round(NATIVE_W * perPixel));
  const canvasH = Math.max(1, Math.round(NATIVE_H * perPixel));
  return { canvasW, canvasH, cssW: canvasW / ratio, cssH: canvasH / ratio };
}

/// Sharp bilinear's first pass: the whole multiple of the `srcW` x `srcH`
/// frame to scale up to with nearest neighbour before bilinear covers the
/// rest. The largest that does not overshoot the canvas; 0 when the canvas
/// is smaller than the frame, and there is nothing to scale up.
function prescaleFactor(canvasW, canvasH, srcW, srcH) {
  const w = srcW > 0 ? srcW : 896;
  const h = srcH > 0 ? srcH : 600;
  const k = Math.floor(Math.min(canvasW / w, canvasH / h));
  return k >= 1 ? k : 0;
}

/// Whether scanlines can be drawn at `rowHeight` device pixels to a BBC
/// line. A gap needs a pixel of its own and the line needs at least one to
/// show: below two, darkening part of a line is darkening the picture.
function scanlinesPossible(rowHeight) {
  return rowHeight >= 2;
}

/// The dark gap in one BBC line `rowHeight` device pixels tall: where it
/// starts below the top of the line, and how tall it is. The lower half of
/// the line, as a CRT's beam leaves it -- in whole pixels when the line is a
/// whole number of them, so every gap is the same crisp band rather than one
/// full pixel and one half-shaded one.
function scanlineBand(rowHeight) {
  let height = rowHeight / 2;
  if (Number.isInteger(rowHeight)) {
    height = Math.max(1, Math.floor(rowHeight / 2));
  }
  return { offset: rowHeight - height, height: height };
}

/// A setting value as the renderer can use it: unknown values fall back to
/// the defaults rather than to nothing, since they come from user settings.
function normaliseView(view) {
  const v = view || {};
  const filter = FILTERS.some((f) => f.id === v.filter) ? v.filter : 'nearest';
  const scale = SCALES.some((s) => s.id === v.scale) ? v.scale : 'fit-integer';
  return { filter, scale, scanlines: percent(v.scanlines, 0) };
}

/// A whole percentage from 0 to 100, or `fallback` when it is not a number.
function percent(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return n < 0 ? 0 : n > 100 ? 100 : n;
}

module.exports = { FILTERS, SCALES, SCANLINE_PRESETS, layoutFor, prescaleFactor, scanlinesPossible, scanlineBand, normaliseView, percent };
