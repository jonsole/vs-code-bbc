// Stepping backwards, on the engine itself: the instants it goes back to, and
// that the past replays exactly.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Engine } from "../server/engine.mjs";

// LDX #0 / loop: INX / JSR sub / JMP loop;  sub: STX &70 / LDA #1 / RTS
async function machine(model = "B-DFS1.2") {
    const e = new Engine({ model, warp: true });
    await e.init();
    await e.bootToPrompt();
    e.writeMemory(0x2000, [0xa2, 0x00, 0xe8, 0x20, 0x00, 0x30, 0x4c, 0x02, 0x20]);
    e.writeMemory(0x3000, [0x86, 0x70, 0xa9, 0x01, 0x60]);
    e.setRegister("pc", 0x2000);
    return e;
}

function fingerprint(e) {
    const s = e.cpu.snapshotState({ includeRoms: true });
    return crypto
        .createHash("md5")
        .update(s.ram)
        .update(JSON.stringify([s.a, s.x, s.y, s.s, s.pc, s.p, e.elapsedCycles]))
        .digest("hex");
}

test("rewind: step back into, over and out; run back to an address and a write; reverse continue", async (t) => {
    const e = await machine();
    t.after(() => e.dispose());
    await e.runFor(1.2);
    await e.runUntil(0x3000);
    const at = e.registers().x;
    const live = fingerprint(e);

    assert.deepEqual(e.stepBack("into", 1), { moved: true, steps: 1 });
    assert.equal(e.cpu.pc, 0x2003, "into: the JSR that called the subroutine");
    e.stepBack("into", 5); // INX, JMP, RTS, LDA, STX
    assert.equal(e.cpu.pc, 0x3000);
    assert.equal(e.registers().x, (at - 1) & 0xff);
    e.stepBack("over", 3); // JSR, INX, JMP -- over the subroutine, not into it
    assert.equal(e.cpu.pc, 0x2006);
    assert.equal(e.registers().x, (at - 2) & 0xff);
    assert.equal(e.stepBack("out", 1).moved, false, "the main loop was entered by no JSR in the history");

    const w = e.runBackToWrite(0x70);
    assert.equal(e.cpu.pc, 0x3000, "stopped before the STX");
    assert.deepEqual([w.write.old, w.write.new], [(at - 3) & 0xff, (at - 2) & 0xff]);
    assert.equal(e.peek(0x70), (at - 3) & 0xff, "the write has not happened yet");

    e.runBackTo(0x3002);
    assert.equal(e.registers().x, (at - 3) & 0xff);
    e.setBreakpoints("t", [{ address: 0x2003 }]);
    const r = e.reverseContinue();
    assert.equal(r.hit, true);
    assert.equal(e.cpu.pc, 0x2003);
    assert.equal(e.lastStop.reason, "breakpoint");
    e.setBreakpoints("t", []);

    assert.equal(e.history.inPast, true);
    assert.equal(e.returnToLive().moved, true);
    assert.equal(fingerprint(e), live, "the present, exactly as it was left");
    assert.equal(e.history.inPast, false);
});

test("rewind: the past replays what was done from outside, and doing something there starts a new timeline", async (t) => {
    const e = new Engine({ model: "Master", warp: true });
    await e.init();
    t.after(() => e.dispose());
    await e.bootToPrompt();
    e.type('10 FOR I=1 TO 30:PRINT I;" ";:NEXT\nRUN');
    await e.runFor(0.5);
    e.writeMemory(0x5000, [1]); // while the text is still being typed
    const written = e.elapsedCycles;
    await e.runFor(2.5);
    const live = fingerprint(e);
    const liveCycles = e.elapsedCycles;
    assert.match(e.screenText(), /29\s+30/);

    e.history.seek(written - 1000);
    assert.notEqual(e.peek(0x5000), 1, "before the write");
    // Run forward through the past: the write, and the typing, happen again.
    await e.runCycles(liveCycles - e.elapsedCycles);
    assert.equal(e.elapsedCycles, liveCycles);
    assert.equal(e.peek(0x5000), 1);
    assert.equal(fingerprint(e), live);

    e.history.seek(written + 200000);
    e.writeMemory(0x5001, [9]);
    assert.equal(e.history.inPast, false, "a new timeline: this is now the present");
    assert.ok(e.history.head < liveCycles);
});
