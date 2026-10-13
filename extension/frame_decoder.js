// Reads the server's screen stream (see server/screen_stream.mjs for the
// format): feed it bytes as they arrive and it calls back with each whole
// frame, inflated, ready for the webview: { width, height, frame, palette, pixels }.
// `palette` is RGB triples and `pixels` one index per pixel, or, when the
// frame had too many colours for a palette, `palette` is null and `pixels`
// is RGB. No vscode API: tested from plain Node.

'use strict';

const zlib = require('zlib');

class FrameDecoder {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + length) {
        return;
      }
      const message = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      this.onFrame(decodeMessage(message));
    }
  }
}

function decodeMessage(buf) {
  const width = buf.readUInt16BE(0);
  const height = buf.readUInt16BE(2);
  const frame = buf.readUInt32BE(4);
  const colours = buf.readUInt16BE(8);
  if (colours === 0) {
    return { width, height, frame, palette: null, pixels: new Uint8Array(zlib.inflateRawSync(buf.subarray(10))) };
  }
  const palette = new Uint8Array(buf.subarray(10, 10 + colours * 3));
  const pixels = new Uint8Array(zlib.inflateRawSync(buf.subarray(10 + colours * 3)));
  return { width, height, frame, palette, pixels };
}

module.exports = { FrameDecoder, decodeMessage };
