import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DebugInfo, detectKind } from "../server/debug_info.mjs";
import { Hello } from "./helpers.mjs";

const src = path.join(Hello, "hello.6502");
const lines = fs.readFileSync(src, "utf8").split(/\r?\n/);
const lineOf = (text) => lines.findIndex((l) => l.includes(text)) + 1;
const lineIs = (text) => lines.findIndex((l) => l.trim() === text) + 1;

test("BeebAsm labels and listing give symbols and source lines", () => {
    const d = new DebugInfo();
    assert.equal(d.loadFile(path.join(Hello, "build/hello.labels")), "symbols");
    assert.equal(d.loadFile(path.join(Hello, "build/hello.lst"), { source: src }), "beebasm-listing");
    assert.equal(d.lookup("start"), 0x1900);
    assert.equal(d.lookup("print_message"), 0x191a);
    assert.equal(d.lookup("print_message.loop"), 0x191c);
    // Two statements on one line: both instructions map to it.
    assert.deepEqual(d.lineFor(0x1900), { file: src, line: lineOf("LDA #22") });
    assert.deepEqual(d.lineFor(0x1902), { file: src, line: lineOf("LDA #22") });
    assert.equal(d.lineFor(0x1921).line, lineIs("JSR oswrch"));
    assert.equal(d.lineFor(0x1927).line, lineOf(".done") + 1);
    // A breakpoint on a label's line lands on the next line with code.
    assert.deepEqual(d.addressForLine(src, lineOf(".again")), { line: lineOf(".again") + 1, address: 0x190e });
    assert.deepEqual(d.nearest(0x1924), { name: "print_message.loop", offset: 8 });
});

test("VICE labels, plain assignments and ca65 .dbg", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbcdbg-"));
    const vice = path.join(dir, "game.lbl");
    fs.writeFileSync(vice, "al C:2000 .main\nal 002010 .loop\n");
    const plain = path.join(dir, "game.sym");
    fs.writeFileSync(plain, "screen = &3000\nscore: $70\n; comment\nplayer 0123\n");
    const dbg = path.join(dir, "game.dbg");
    fs.writeFileSync(
        dbg,
        [
            "version\tmajor=2,minor=0",
            'file\tid=0,name="game.s",size=100,mtime=0x0,mod=0',
            "seg\tid=0,name=\"CODE\",start=0x001900,size=0x10,addrsize=absolute,type=rw",
            "span\tid=0,seg=0,start=0,size=2",
            "span\tid=1,seg=0,start=2,size=3",
            "line\tid=0,file=0,line=10,span=0",
            "line\tid=1,file=0,line=11,span=1",
            'sym\tid=0,name="entry",addrsize=absolute,scope=0,def=0,val=0x1900,seg=0,type=lab',
        ].join("\n"),
    );
    const d = new DebugInfo();
    d.loadFile(vice);
    d.loadFile(plain);
    assert.equal(detectKind(dbg, fs.readFileSync(dbg, "utf8")), "ca65");
    d.loadFile(dbg);
    assert.equal(d.lookup("main"), 0x2000);
    assert.equal(d.lookup("loop"), 0x2010);
    assert.equal(d.lookup("screen"), 0x3000);
    assert.equal(d.lookup("score"), 0x70);
    assert.equal(d.lookup("player"), 0x123);
    assert.equal(d.lookup("entry"), 0x1900);
    assert.deepEqual(d.lineFor(0x1902), { file: path.join(dir, "game.s"), line: 11 });
});
