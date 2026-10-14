// Check fast3d.6502's routines against model.mjs, and time them.
//
// The routines (build/checks.bin, from checks.6502) run on jsbeeb's own 6502
// with nothing else attached, and every result is compared with the model's:
//
// 1. mul8s, for every one of the 65,536 pairs of signed bytes.
// 2. make_matrix, for every x angle against a spread of y and z (and the
//    nine entries it keeps), and rotate with each matrix, on vertices that
//    include every corner of the cube of signed bytes -- the largest sums.
// 3. divide_unsigned, on the edges of what fits a byte and a random spread.
// 4. project and transform, on random vertices, matrices and distances.
// 5. draw_line, every byte of the 10K screen after each batch of lines,
//    against model.line, on lines every way and length and on both screens
//    (&3000 and &5800); and clear_box.
// 6. The demo (DEMO, from build/fast3d.ssd): draw_frame, frame after frame
//    for each object, on the screen at &3000 (so clearing its own last box),
//    against the model's picture of the same frame; and timed. A frame goes
//    to demo.png.
//
// The cycles come from the CPU's own count, page crossings and all.
//
//     node examples/fast3d/check.mjs          (after building checks.6502)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fake6502 } from "../../vendor/jsbeeb/src/fake6502.js";
import * as model from "./model.mjs";
import { encodePng } from "../../server/png.mjs";

const Here = path.dirname(fileURLToPath(import.meta.url));
const Build = path.join(Here, "build");
const RETURN = 0x0d00; // a return address nothing runs
const ZP = 0x70; // FAST3D_ZP, and the variables at it, as fast3d.6502 has them
const Zp = { acc: 0, rot_x: 2, rot_y: 4, rot_z: 6, zoff: 8, angle_x: 13, div_lo: 16, div_by: 17, vptr: 18, pptr: 20, count: 22, screen_x: 23, screen_y: 24, screen_add: 25 };

/** BeebAsm's -labels dump: [{'.name':valueL,...}] */
export function readLabels(file) {
    const labels = {};
    for (const [, name, value] of fs.readFileSync(file, "utf8").matchAll(/'\.([^']+)':(\d+)L/g)) labels[name] = Number(value);
    return labels;
}

export class Machine {
    static async create() {
        const machine = new Machine();
        await machine.cpu.initialise();
        machine.load();
        return machine;
    }
    constructor() {
        this.cpu = fake6502();
        this.cpu.debugInstruction.add((pc) => pc === RETURN);
    }
    load() {
        this.labels = readLabels(path.join(Build, "checks.labels"));
        const image = fs.readFileSync(path.join(Build, "checks.bin"));
        image.forEach((b, i) => this.cpu.writemem(this.labels.start + i, b));
    }
    peek(address) {
        return this.cpu.readmem(address);
    }
    poke(address, bytes) {
        bytes.forEach((b, i) => this.cpu.writemem(address + i, b & 0xff));
    }
    zp(name) {
        return ZP + Zp[name];
    }
    word(address) {
        const value = this.peek(address) | (this.peek(address + 1) << 8);
        return value & 0x8000 ? value - 0x10000 : value;
    }
    /** Run a routine to its RTS; the cycles it took. */
    call(name, { a = 0, x = 0, y = 0 } = {}) {
        const cpu = this.cpu;
        cpu.a = a & 0xff;
        cpu.x = x & 0xff;
        cpu.y = y & 0xff;
        cpu.p.i = true;
        cpu.p.d = false;
        cpu.s = 0xfd;
        cpu.writemem(0x1fe, (RETURN - 1) & 0xff);
        cpu.writemem(0x1ff, (RETURN - 1) >> 8);
        cpu.pc = this.labels[name];
        const start = this.cycles();
        cpu.execute(10_000_000);
        if (cpu.pc !== RETURN) throw new Error(`${name} did not return`);
        return this.cycles() - start;
    }
    cycles() {
        // jsbeeb counts in seconds of 2,000,000 cycles and the cycles since
        return this.cpu.cycleSeconds * 2_000_000 + this.cpu.currentCycles;
    }
}

function report(name, times, per = 1) {
    times = times.map((t) => t / per);
    const low = times.reduce((a, b) => Math.min(a, b));
    const high = times.reduce((a, b) => Math.max(a, b));
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const spread = low === high ? `${low}` : `${Math.round(low)}..${Math.round(high)}, mean ${Math.round(mean)}`;
    console.log(`  ${name.padEnd(14)} ${spread} cycles (${times.length.toLocaleString()} runs)`);
}

const signed8 = (v) => (v & 0x80 ? v - 256 : v);

function random(seed) {
    // xorshift32: the same spread every run
    let state = seed;
    return (n) => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) % n;
    };
}

function checkTables(m, failures) {
    for (let n = -256; n < 256; n++) {
        const f = model.quarterSquare(n);
        const at = m.labels.SQ_LO + 256 + n;
        if (m.peek(at) !== (f & 0xff) || m.peek(at + 512) !== f >> 8) failures.push(`SQ ${n}`);
    }
    for (let a = 0; a < 512; a++) {
        const v = model.sine(a) & 0xffff;
        if (m.peek(m.labels.SINE_LO + a) !== (v & 0xff) || m.peek(m.labels.SINE_HI + a) !== v >> 8) failures.push(`SINE ${a}`);
    }
}

function checkMul8s(m, failures) {
    const times = [];
    for (let a = -128; a < 128; a++) {
        for (let b = -128; b < 128; b++) {
            times.push(m.call("mul8s", { a, y: b }));
            let got = (m.cpu.a << 8) | m.cpu.x;
            if (got & 0x8000) got -= 0x10000;
            if (got !== a * b && failures.length < 10) failures.push(`mul8s ${a} * ${b}: ${got}, not ${a * b}`);
        }
    }
    report("mul8s", times);
}

function checkMatrixAndRotate(m, failures) {
    const matrixTimes = [];
    const rotateTimes = [];
    const rnd = random(3);
    const corners = [];
    for (const x of [-128, 127]) for (const y of [-128, 127]) for (const z of [-128, 127]) corners.push([x, y, z]);
    const angles = [];
    for (let x = 0; x < 256; x++) for (let y = 0; y < 256; y += 37) for (let z = 0; z < 256; z += 53) angles.push([x, y, z]);
    for (let i = 0; i < 2000; i++) angles.push([rnd(256), rnd(256), rnd(256)]);
    const vertexAt = m.labels.checks_vertices;
    for (const [x, y, z] of angles) {
        m.poke(m.zp("angle_x"), [x, y, z]);
        matrixTimes.push(m.call("make_matrix"));
        const want = model.makeMatrix(x, y, z);
        const got = [...Array(9).keys()].map((i) => signed8(m.peek(m.labels.matrix + i)));
        if (got.join() !== want.join()) {
            failures.push(`make_matrix ${x},${y},${z}: ${got}, not ${want}`);
            if (failures.length > 10) return;
            continue;
        }
        const vertices = [...corners];
        for (let i = 0; i < 4; i++) vertices.push([rnd(256) - 128, rnd(256) - 128, rnd(256) - 128]);
        for (const vertex of vertices) {
            m.poke(vertexAt, vertex);
            m.poke(m.zp("vptr"), [vertexAt & 0xff, vertexAt >> 8]);
            rotateTimes.push(m.call("rotate"));
            const gotR = ["rot_x", "rot_y", "rot_z"].map((n) => m.word(m.zp(n)));
            const wantR = model.rotate(want, vertex);
            if (gotR.join() !== wantR.join()) {
                failures.push(`rotate ${vertex} by ${want}: ${gotR}, not ${wantR}`);
                if (failures.length > 10) return;
            }
        }
    }
    report("make_matrix", matrixTimes);
    report("rotate", rotateTimes);
}

function checkDivide(m, failures) {
    const times = [];
    const rnd = random(4);
    const cases = [];
    for (let c = 1; c < 256; c++) for (const q of [0, 1, 127, 128, 254, 255, 256]) for (const r of [0, c - 1]) cases.push([q * c + r, c]);
    for (let i = 0; i < 20000; i++) cases.push([rnd(65536), 1 + rnd(255)]);
    for (const [n, c] of cases) {
        if (n > 0xffff) continue;
        m.poke(m.zp("div_lo"), [n & 0xff, c]);
        times.push(m.call("divide_unsigned", { a: n >> 8 }));
        const want = Math.floor(n / c) > 255 ? null : Math.floor(n / c);
        const got = m.cpu.p.c ? null : m.cpu.a;
        if (got !== want && failures.length < 10) failures.push(`divide ${n} / ${c}: ${got}, not ${want}`);
    }
    report("divide", times);
}

function checkTransform(m, failures) {
    const projectTimes = [];
    const transformTimes = [];
    const rnd = random(5);
    const vertexAt = m.labels.checks_vertices;
    const pointAt = m.labels.checks_points;
    for (let round = 0; round < 300; round++) {
        const [x, y, z] = [rnd(256), rnd(256), rnd(256)];
        m.poke(m.zp("angle_x"), [x, y, z]);
        m.call("make_matrix");
        const matrix = model.makeMatrix(x, y, z);
        const zoff = rnd(2) ? 28800 + rnd(7200) : 256 + rnd(65536 - 28800 - 256);
        m.poke(m.zp("zoff"), [zoff & 0xff, zoff >> 8]);
        const vertices = [];
        for (let i = 0; i < 16; i++) vertices.push([rnd(256) - 128, rnd(256) - 128, rnd(256) - 128]);
        let all = true;
        for (const vertex of vertices) {
            const rotated = model.rotate(matrix, vertex);
            const z8 = (rotated[2] + zoff) >> 8;
            if (z8 < 1 || z8 > 255) {
                all = false;
                continue; // outside what project is for
            }
            ["rot_x", "rot_y", "rot_z"].forEach((n, i) => m.poke(m.zp(n), [rotated[i] & 0xff, (rotated[i] >> 8) & 0xff]));
            projectTimes.push(m.call("project"));
            const got = m.cpu.p.c ? null : [m.peek(m.zp("screen_x")), m.peek(m.zp("screen_y"))];
            const want = model.project(rotated, zoff);
            if (String(got) !== String(want)) failures.push(`project ${rotated} zoff ${zoff}: ${got}, not ${want}`);
        }
        if (!all) continue;
        m.poke(vertexAt, vertices.flat());
        m.poke(m.zp("vptr"), [vertexAt & 0xff, vertexAt >> 8]);
        m.poke(m.zp("pptr"), [pointAt & 0xff, pointAt >> 8]);
        m.poke(m.zp("count"), [vertices.length]);
        transformTimes.push(m.call("transform"));
        vertices.forEach((vertex, i) => {
            const want = model.project(model.rotate(matrix, vertex), zoff);
            const got = [m.peek(pointAt + 2 * i), m.peek(pointAt + 2 * i + 1)];
            if ((want === null && got[1] !== 0xff) || (want !== null && String(got) !== String(want))) {
                failures.push(`transform ${vertex} at ${x},${y},${z} zoff ${zoff}: ${got}, not ${want}`);
            }
        });
        if (failures.length > 10) return;
    }
    report("project", projectTimes);
    report("transform", transformTimes, 16);
    console.log("                 (transform: per vertex, of 16)");
}

const screenBytes = (m, base) => Uint8Array.from({ length: 10240 }, (_, i) => m.peek(base + i));
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function checkLines(m, failures) {
    const times = [];
    const along = { x: [], y: [] };
    const rnd = random(6);
    const lines = [[0, 0, 255, 254], [255, 0, 0, 254], [0, 254, 255, 0], [5, 9, 5, 9], [0, 100, 255, 100],
        [255, 50, 0, 50], [17, 0, 17, 254], [200, 254, 200, 0], [0, 0, 254, 254], [255, 0, 64, 254]];
    for (let i = 0; i < 3000; i++) {
        let [x0, y0, x1, y1] = [rnd(256), rnd(255), rnd(256), rnd(255)];
        if (rnd(4) === 0) {
            x1 = Math.max(0, Math.min(255, x0 + rnd(19) - 9));
            y1 = Math.max(0, Math.min(254, y0 + rnd(19) - 9));
        }
        lines.push([x0, y0, x1, y1]);
    }
    for (const [base, add, step] of [[0x3000, 0, 8], [0x5800, 0x28, 500]]) {
        m.poke(m.zp("screen_add"), [add]);
        for (let start = 0; start < lines.length; start += step) {
            const batch = step === 8 ? lines.slice(start, start + 8) : lines.slice(start, start + 3);
            m.poke(base, new Array(10240).fill(0));
            for (const l of batch) {
                m.poke(m.zp("rot_x"), l);  // line_x0, line_y0, line_x1, line_y1
                const t = m.call("draw_line");
                times.push(t);
                const pixels = model.line(...l).length;
                if (pixels > 40) along[Math.abs(l[2] - l[0]) >= Math.abs(l[3] - l[1]) ? "x" : "y"].push(t / pixels);
            }
            if (!sameBytes(screenBytes(m, base), model.render(batch, base))) {
                failures.push(`draw_line at &${base.toString(16)}: ${JSON.stringify(batch)} differ from the model`);
                if (failures.length > 5) return;
            }
        }
    }
    report("draw_line", times);
    const mean = (a) => Math.round(a.reduce((p, q) => p + q, 0) / a.length);
    console.log(`  ${"".padEnd(14)} ${mean(along.x)} cycles a pixel along x, ${mean(along.y)} along y (lines over 40 pixels)`);

    const clearTimes = [];
    m.poke(m.zp("screen_add"), [0]);
    for (let i = 0; i < 200; i++) {
        const rows = 1 + rnd(32);
        const top = rnd(33 - rows);
        const width = 1 + rnd(32);
        const left = rnd(33 - width);
        m.poke(0x3000, new Array(10240).fill(0xff));
        m.poke(m.zp("rot_x"), [left, 0, width]);  // line_x0, line_x1
        clearTimes.push(m.call("clear_box", { a: top, x: rows }));
        const want = new Uint8Array(10240).fill(0xff);
        for (let y = top * 8; y < (top + rows) * 8; y++) for (let col = left; col < left + width; col++) want[model.screenAddress(col * 8, y) - 0x3000] = 0;
        if (!sameBytes(screenBytes(m, 0x3000), want)) failures.push(`clear_box rows ${top}+${rows} columns ${left}+${width}`);
    }
    report("clear_box", clearTimes);
}

/** A file from a DFS disc image: [load address, bytes]. */
export function ssdFile(ssd, name) {
    for (let i = 8; i < 8 + ssd[0x105]; i += 8) {
        const fileName = String.fromCharCode(...ssd.subarray(i, i + 7)).trimEnd();
        if (fileName !== name) continue;
        const info = ssd.subarray(0x100 + i, 0x108 + i);
        const top = info[6];
        const load = info[0] | (info[1] << 8);
        const length = info[4] | (info[5] << 8) | (((top >> 4) & 3) << 16);
        const sector = info[7] | ((top & 3) << 8);
        return [load, ssd.subarray(sector * 256, sector * 256 + length)];
    }
    throw new Error(`no ${name} on the disc`);
}

/** The demo's objects, from objects.6502. */
function readObjects() {
    const text = fs.readFileSync(path.join(Here, "objects.6502"), "utf8");
    const result = [];
    for (const name of ["cube", "icosahedron"]) {
        const vertices = [...text.split(`.${name}_vertices`)[1].split(`.${name}_edges`)[0].matchAll(/LO\((-?\d+)\), LO\((-?\d+)\), LO\((-?\d+)\)/g)].map((m) => m.slice(1).map(Number));
        const edges = [...text.split(`.${name}_edges`)[1].split("\n\n")[0].matchAll(/EQUB (\d+), (\d+)/g)].map((m) => m.slice(1).map(Number));
        result.push({ name, vertices, edges });
    }
    return result;
}

async function checkDemo(failures, picture) {
    const m = new Machine();
    await m.cpu.initialise();
    m.labels = readLabels(path.join(Build, "demo.labels"));
    const [, image] = ssdFile(fs.readFileSync(path.join(Build, "fast3d.ssd")), "DEMO");
    m.poke(0x0e00, [...image]); // assembled to run at &0E00, where it copies itself
    const distance = 400;
    m.poke(m.zp("zoff"), [(distance * 128) & 0xff, (distance * 128) >> 8]);
    m.poke(m.zp("screen_add"), [0]);
    m.poke(m.zp("angle_x"), [0, 0, 0]);
    m.poke(0x3000, new Array(10240).fill(0));
    const frames = [];
    for (const [index, { name, vertices, edges }] of readObjects().entries()) {
        const pointer = m.labels.objects + 6 * index;
        m.poke(0x8a, [pointer & 0xff, pointer >> 8]); // the demo's `object`
        const times = [];
        for (let i = 0; i < 64; i++) {
            times.push(m.call("draw_frame"));
            const angles = [0, 1, 2].map((a) => m.peek(m.zp("angle_x") + a));
            const matrix = model.makeMatrix(...angles);
            const points = vertices.map((v) => model.project(model.rotate(matrix, v), distance * 128));
            const lines = edges.filter(([a, b]) => points[a] && points[b]).map(([a, b]) => [...points[a], ...points[b]]);
            const got = screenBytes(m, 0x3000);
            if (!sameBytes(got, model.render(lines, 0x3000))) {
                failures.push(`demo: the ${name} at angles ${angles} differs from the model`);
                break;
            }
            frames.push(got);
        }
        report(`demo: ${name}`, times);
    }
    if (!picture) return;
    // a frame as the BBC shows it: white on black, the whole 320 x 256
    const frame = frames[20];
    const rgba = new Uint8Array(320 * 256 * 4);
    for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 320; x++) {
            const on = frame[(y >> 3) * 320 + (y & 7) + (x >> 3) * 8] & (0x80 >> (x & 7));
            rgba.set(on ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 320 + x) * 4);
        }
    }
    fs.writeFileSync(picture, encodePng(rgba, 320, 256));
    console.log(`  a frame to ${picture}`);
}

/** Every check; the failures. `picture`: where to write a frame of the demo, as a PNG. */
export async function runChecks({ picture } = {}) {
    const m = await Machine.create();
    const failures = [];
    checkTables(m, failures);
    for (const check of [checkMul8s, checkMatrixAndRotate, checkDivide, checkTransform, checkLines]) check(m, failures);
    await checkDemo(failures, picture);
    return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const failures = await runChecks({ picture: path.join(Here, "demo.png") });
    if (failures.length) {
        console.log(failures.slice(0, 20).join("\n"));
        console.log(`${failures.length} failures`);
        process.exit(1);
    }
    console.log("All match the model.");
}
