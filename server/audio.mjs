// The sound the machine makes: jsbeeb's SN76489 renders at its own 500kHz,
// into a buffer its headless build throws away. This takes those buffers,
// averages them down to 44.1kHz, and keeps the last few seconds -- what
// get_audio measures and hands back as a WAV -- and passes them on to anyone
// listening live (the screen panel).
//
// Headless, the chip only renders when it is written to, so the engine has it
// catch up after every slice the machine runs. What a replay of the past
// renders is not kept: it was heard the first time.

export const SampleRate = 44100;
const ChipRate = 500000;
const KeptSeconds = 4;

export class AudioTap {
    /** @param {import("./engine.mjs").Engine} engine */
    constructor(engine) {
        this.engine = engine;
        this.ring = new Float32Array(SampleRate * KeptSeconds);
        this.written = 0; // samples ever written: the ring's head is written % length
        this._acc = 0;
        this._accN = 0;
        this._phase = 0;
        this._listeners = new Set();
        this._chunk = [];
        this.attach();
    }

    get chip() {
        return this.engine.session._soundChip;
    }

    /** Take the chip's output; again after the machine is rebuilt. */
    attach() {
        const chip = this.chip;
        if (!chip || chip._onBuffer === undefined) return;
        chip._onBuffer = (buffer) => {
            if (!this.engine._replaying) this._take(buffer);
        };
    }

    _take(buffer) {
        const step = SampleRate / ChipRate;
        let acc = this._acc;
        let n = this._accN;
        let phase = this._phase;
        for (let i = 0; i < buffer.length; i++) {
            acc += buffer[i];
            n++;
            phase += step;
            if (phase >= 1) {
                phase -= 1;
                this._put(acc / n);
                acc = 0;
                n = 0;
            }
        }
        this._acc = acc;
        this._accN = n;
        this._phase = phase;
    }

    _put(v) {
        this.ring[this.written % this.ring.length] = v;
        this.written++;
        if (this._listeners.size) this._chunk.push(v);
    }

    /** After each slice: render what the chip owes, and hand it to live listeners. */
    catchUp() {
        this.chip?.catchUp?.();
        if (this._chunk.length) {
            const pcm = new Int16Array(this._chunk.length);
            for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(this._chunk[i] * 32767)));
            this._chunk = [];
            for (const l of this._listeners) l(pcm);
        }
    }

    /** Live 16-bit mono samples at 44.1kHz, as rendered. */
    listen(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    /** The last `ms` of sound (as much as is kept). */
    recent(ms) {
        const n = Math.min(this.written, this.ring.length, Math.round((ms / 1000) * SampleRate));
        const out = new Float32Array(n);
        const start = this.written - n;
        for (let i = 0; i < n; i++) out[i] = this.ring[(start + i) % this.ring.length];
        return out;
    }
}

/** Loudness and pitch of some samples: { samples, rms, peak, pitch_hz }. */
export function measure(samples) {
    let sum = 0;
    let peak = 0;
    for (const v of samples) {
        sum += v * v;
        peak = Math.max(peak, Math.abs(v));
    }
    const rms = samples.length ? Math.sqrt(sum / samples.length) : 0;
    return { samples: samples.length, duration_ms: Math.round((samples.length / SampleRate) * 1000), rms: round(rms), peak: round(peak), pitch_hz: rms > 0.002 ? pitch(samples) : null };
}

function round(v) {
    return Math.round(v * 10000) / 10000;
}

/** The fundamental by autocorrelation over the last stretch: 30Hz to 5kHz. */
function pitch(samples) {
    const n = Math.min(samples.length, 8192);
    const x = samples.subarray(samples.length - n);
    const minLag = Math.floor(SampleRate / 5000);
    const maxLag = Math.min(Math.floor(SampleRate / 30), n >> 1);
    let energy = 0;
    for (let i = 0; i < n; i++) energy += x[i] * x[i];
    if (energy === 0) return null;
    const corr = new Float64Array(maxLag + 1);
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
        let c = 0;
        for (let i = 0; i + lag < n; i++) c += x[i] * x[i + lag];
        corr[lag] = c / (n - lag);
        if (corr[lag] > best) best = corr[lag];
    }
    if (best <= 0) return null;
    // The first lag that comes close to the best: the fundamental, not a multiple of it.
    for (let lag = minLag + 1; lag < maxLag; lag++) {
        if (corr[lag] >= 0.9 * best && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
            // Between samples: a parabola through the peak.
            const a = corr[lag - 1];
            const b = corr[lag];
            const c = corr[lag + 1];
            const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
            return Math.round((SampleRate / (lag + shift)) * 10) / 10;
        }
    }
    return null;
}

/** 16-bit mono WAV of some samples. */
export function wav(samples) {
    const data = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);
    h.writeUInt32LE(36 + data.length, 4);
    h.write("WAVE", 8);
    h.write("fmt ", 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(SampleRate, 24);
    h.writeUInt32LE(SampleRate * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36);
    h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
}
