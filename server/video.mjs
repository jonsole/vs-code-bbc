// A video of the screen for a person to watch: every frame the machine paints,
// at the BBC's own 50 a second, piped to ffmpeg, which encodes it in the
// format the file's extension asks for (.mp4 plays everywhere).
//
// Frames are written as raw RGBA to ffmpeg's stdin. An encoder that falls
// behind does not hold up the machine: once two seconds of frames are queued,
// further ones are dropped and counted, and the status says how many.
//
// The picture's size is fixed at the start (the visible area then); a mode
// with other borders is cut or padded to it.

import { spawn } from "node:child_process";
import path from "node:path";

const Fps = 50;
const FbWidth = 1024;

export class VideoRecorder {
    /**
     * @param {import("./engine.mjs").Engine} engine
     * @param {{ path: string, seconds?: number, frames?: number, scale?: number, ffmpeg?: string }} opts
     */
    constructor(engine, { path: file, seconds, frames, scale = 2, ffmpeg = "ffmpeg" }) {
        this.engine = engine;
        this.path = path.resolve(file);
        this.limit = frames ?? (seconds !== undefined ? Math.round(seconds * Fps) : 0);
        this.frames = 0;
        this.dropped = 0;
        this.active = true;
        this.exitCode = null;
        this.error = null;

        const v = engine.session._video;
        this.left = v.leftBorder;
        this.top = v.topBorder;
        this.width = FbWidth - v.leftBorder - v.rightBorder;
        this.height = 625 - v.topBorder - v.bottomBorder;
        this._frameBytes = this.width * this.height * 4;
        this._maxQueued = this._frameBytes * Fps * 2;
        const k = Math.max(1, Math.min(4, scale | 0));

        this._exited = new Promise((resolve) => (this._onExit = resolve));
        // prettier-ignore
        const args = [
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${this.width}x${this.height}`, "-r", String(Fps), "-i", "-",
            // Whole pixels, and even sides, which most encoders need.
            "-vf", `scale=trunc(iw*${k}/2)*2:trunc(ih*${k}/2)*2:flags=neighbor`,
            "-pix_fmt", "yuv420p",
            this.path,
        ];
        this._stderr = "";
        this._proc = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] });
        this._proc.stderr.on("data", (d) => (this._stderr = (this._stderr + d).slice(-2000)));
        this._proc.on("error", (e) => {
            this.error = e.code === "ENOENT" ? `ffmpeg was not found (${ffmpeg}): install it, or start the server with --ffmpeg <path>` : e.message;
            this._finish(null);
        });
        this._proc.on("exit", (code) => {
            if (code !== 0 && !this.error) this.error = this._stderr.trim() || `ffmpeg exited with ${code}`;
            this._finish(code);
        });
        this._proc.stdin.on("error", () => {}); // a dead encoder is reported by its exit
        this._off = engine.onPaint(() => this._frame());
    }

    _frame() {
        if (!this.active) return;
        const stdin = this._proc.stdin;
        if (stdin.writableLength > this._maxQueued) {
            this.dropped++;
        } else {
            const src = this.engine.session._completeFb8;
            const out = Buffer.allocUnsafe(this._frameBytes);
            const row = this.width * 4;
            for (let y = 0; y < this.height; y++) {
                const from = ((this.top + y) * FbWidth + this.left) * 4;
                out.set(src.subarray(from, from + row), y * row);
            }
            stdin.write(out);
        }
        this.frames++;
        if (this.limit > 0 && this.frames >= this.limit) this.stop();
    }

    _finish(code) {
        this.active = false;
        this.exitCode = code;
        this._off?.();
        this._onExit();
    }

    /** Stop taking frames and let ffmpeg finish the file; resolves when it has. */
    async stop() {
        if (this.active) {
            this.active = false;
            this._off?.();
            this._proc.stdin.end();
        }
        await Promise.race([this._exited, new Promise((r) => setTimeout(r, 15000))]);
        return this.status();
    }

    status() {
        const out = { active: this.active, path: this.path, frames: this.frames, duration_ms: this.frames * (1000 / Fps), dropped: this.dropped };
        if (this.limit) out.limit = this.limit;
        if (!this.active) out.exit_code = this.exitCode;
        if (this.error) out.error = this.error;
        return out;
    }
}
