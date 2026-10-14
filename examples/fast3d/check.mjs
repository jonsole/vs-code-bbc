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
//
// The cycles come from the CPU's own count, page crossings and all.
//
//     node examples/fast3d/check.mjs          (after building checks.6502)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fake6502 } from "../../vendor/jsbeeb/src/fake6502.js";
import * as model from "./model.mjs";

const Here = path.dirname(fileURLToPath(import.meta.url));
const Build = path.join(Here, "build");
const RETURN = 0x0e00; // a return address nothing runs
const ZP = 0x70; // FAST3D_ZP, and the variables at it, as fast3d.6502 has them
const Zp = { acc: 0, rot_x: 2, rot_y: 4, rot_z: 6, zoff: 8, angle_x: 13, div_lo: 16, div_by: 17, vptr: 18, pptr: 20, count: 22, screen_x: 23, screen_y: 24 };

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
    }
    load() {
        this.labels = readLabels(path.join(Build, "checks.labels"));
        const image = fs.readFileSync(path.join(Build, "checks.bin"));
        image.forEach((b, i) => this.cpu.writemem(this.labels.start + i, b));
        this.cpu.debugInstruction.add((pc) => pc === RETURN);
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

export async function runChecks() {
    const m = await Machine.create();
    const failures = [];
    checkTables(m, failures);
    for (const check of [checkMul8s, checkMatrixAndRotate, checkDivide, checkTransform]) check(m, failures);
    return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const failures = await runChecks();
    if (failures.length) {
        console.log(failures.slice(0, 20).join("\n"));
        console.log(`${failures.length} failures`);
        process.exit(1);
    }
    console.log("All match the model.");
}
