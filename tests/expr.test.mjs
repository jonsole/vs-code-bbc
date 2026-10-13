import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, parseNumber } from "../server/expr.mjs";

const mem = new Uint8Array(0x10000);
mem[0x70] = 0x34;
mem[0x71] = 0x12;
const ctx = {
    register: (n) => ({ a: 0x41, x: 2, y: 0, s: 0xff, p: 0x31, pc: 0x1900 })[n],
    peek: (a) => mem[a],
    symbol: (n) => ({ counter: 0x70, start: 0x1900 })[n],
};
const ev = (t) => evaluate(t, ctx);

test("numbers in every notation", () => {
    assert.equal(parseNumber("&1900"), 0x1900);
    assert.equal(parseNumber("$ff"), 255);
    assert.equal(parseNumber("0x10"), 16);
    assert.equal(parseNumber("%101"), 5);
    assert.equal(parseNumber("42"), 42);
    assert.equal(parseNumber("zz"), undefined);
});

test("registers, flags and symbols", () => {
    assert.equal(ev("A"), 0x41);
    assert.equal(ev("pc"), 0x1900);
    assert.equal(ev("C"), 1); // P=&31: carry set
    assert.equal(ev("Z"), 0);
    assert.equal(ev("start+2"), 0x1902);
});

test("memory: ? for a byte, peekw for a word", () => {
    assert.equal(ev("?counter"), 0x34);
    assert.equal(ev("?(counter+1)"), 0x12);
    assert.equal(ev("?counter+1"), 0x35);
    assert.equal(ev("peekw(&70)"), 0x1234);
});

test("C and BBC BASIC operators", () => {
    assert.equal(ev("A=&41"), 1);
    assert.equal(ev("A==65 && X<>3"), 1);
    assert.equal(ev("A AND &F0"), 0x40);
    assert.equal(ev("A & &0F"), 1);
    assert.equal(ev("NOT 0"), 1);
    assert.equal(ev("1+2*3"), 7);
    assert.equal(ev("(1+2)*3"), 9);
    assert.equal(ev("7 MOD 4"), 3);
    assert.equal(ev("1 << 4 | 1"), 17);
});

test("errors say what is wrong", () => {
    assert.throws(() => ev("nosuch"), /Unknown name "nosuch"/);
    assert.throws(() => ev("(1"), /Missing \)/);
    assert.throws(() => ev("1/0"), /Division by zero/);
});
