import test from "node:test";
import assert from "node:assert/strict";
import { VduTranscript } from "../server/vdu_transcript.mjs";

const feed = (t, ...parts) => {
    for (const p of parts) {
        if (typeof p === "string") for (const c of p) t.write(c.charCodeAt(0));
        else t.write(p);
    }
};

test("text in order, CLS as a break, newlines from CR LF", () => {
    const t = new VduTranscript();
    // PRINT "A" : CLS : PRINT "B", as BASIC sends it: OSASCI turns CR into LF CR.
    feed(t, "A", 10, 13, 12, "B", 10, 13);
    assert.equal(t.take(), "A\n\fB\n");
    assert.equal(t.take(), "", "taken");
});

test("parameters are skipped: VDU 31,x,y and colours print nothing", () => {
    const t = new VduTranscript();
    feed(t, 31, 10, 5, "X", 17, 1, "Y", 19, 1, 2, 0, 0, 0, "Z");
    assert.equal(t.take(), "XYZ", "the 10 in VDU 31,10,5 is a parameter, not a newline");
});

test("MODE is a break once its number has gone by", () => {
    const t = new VduTranscript();
    feed(t, "old", 22, 7, "new");
    assert.equal(t.take(), "old\fnew");
});

test("DELETE takes back a typed character; a peek leaves the text", () => {
    const t = new VduTranscript();
    feed(t, "PRUNT", 127, 127, 127, "INT");
    assert.equal(t.take({ clear: false }), "PRINT");
    assert.equal(t.take(), "PRINT");
});

test("LF CR and CR LF are one newline, two LFs are two", () => {
    const t = new VduTranscript();
    feed(t, "a", 13, 10, "b", 10, 13, "c", 10, 10, "d");
    assert.equal(t.take(), "a\nb\nc\n\nd");
});
