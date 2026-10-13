#!/usr/bin/env node
// Refresh vendor/jsbeeb from a jsbeeb checkout: the source files the headless
// machine reaches by import from src/index.js, the ROMs, the licence, and the
// one runtime dependency (pako). Usage:
//   node scripts/update-jsbeeb.mjs <path-to-jsbeeb-checkout> [<path-to-pako>]
// pako defaults to <checkout>/node_modules/pako (run `npm install` there first).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [checkout, pakoArg] = process.argv.slice(2);
if (!checkout) {
    console.error("usage: node scripts/update-jsbeeb.mjs <jsbeeb-checkout> [<pako-dir>]");
    process.exit(2);
}
const src = path.resolve(checkout);
const dest = path.join(repoRoot, "vendor", "jsbeeb");
const pakoDir = path.resolve(pakoArg ?? path.join(src, "node_modules", "pako"));

// Walk relative imports (static and dynamic) from the entry points.
// snapshot.js: the web app's save-state format, which the server reads and writes too.
const entries = ["src/index.js", "src/machine-session.js", "src/snapshot.js"];
const seen = new Set();
const bare = new Set();
const importRe = /(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
function walk(rel) {
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = fs.readFileSync(path.join(src, rel), "utf8");
    for (const m of text.matchAll(importRe)) {
        const spec = m[1] ?? m[2];
        if (spec.startsWith(".")) walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
        else bare.add(spec);
    }
}
entries.forEach(walk);

fs.rmSync(dest, { recursive: true, force: true });
for (const rel of [...seen].sort()) {
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(path.join(src, rel), path.join(dest, rel));
}
fs.cpSync(path.join(src, "public", "roms"), path.join(dest, "public", "roms"), { recursive: true });
fs.copyFileSync(path.join(src, "LICENSE"), path.join(dest, "LICENSE"));
// jsbeeb is ES modules; say so, so Node does not have to guess from the syntax.
fs.writeFileSync(path.join(dest, "package.json"), JSON.stringify({ name: "jsbeeb-vendored", private: true, type: "module" }, null, 2) + "\n");
fs.cpSync(pakoDir, path.join(dest, "node_modules", "pako"), {
    recursive: true,
    filter: (p) => !/[\\/](test|benchmark|\.github|browser)$|\.map$|README\.md$/.test(p),
});

let commit = "unknown";
try {
    commit = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {}
const version = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")).version;
const pakoVersion = JSON.parse(fs.readFileSync(path.join(pakoDir, "package.json"), "utf8")).version;
fs.writeFileSync(
    path.join(dest, "VENDORED.md"),
    `# Vendored jsbeeb\n\n` +
        `Copied by \`scripts/update-jsbeeb.mjs\` from https://github.com/mattgodbolt/jsbeeb\n\n` +
        `- jsbeeb ${version}, commit \`${commit}\`\n- pako ${pakoVersion} (node_modules/pako, MIT)\n\n` +
        `Only the ${seen.size} source files reachable from src/index.js are kept, plus public/roms.\n` +
        `Do not edit these files: change jsbeeb upstream, or wrap it in server/.\n` +
        `Bare imports seen: ${[...bare].sort().join(", ")}\n`,
);
console.log(`vendored ${seen.size} files from jsbeeb ${version} (${commit.slice(0, 7)}); bare imports: ${[...bare].join(", ")}`);
