#!/usr/bin/env node
// Rewrites the tool tables in docs/mcp.md, between its "tools:start" and
// "tools:end" markers, from the tool definitions in server/mcp.mjs -- so
// the documentation says what the server does. Run after changing a tool:
//   node scripts/mcp-docs.mjs
// Every tool must be in one of the groups below; a new one fails this
// until it is placed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTools } from "../server/mcp.mjs";

const Groups = [
    ["The machine", ["server_info", "get_state", "reset", "set_speed"]],
    ["Loading", ["load_program", "load_disc", "load_basic", "run_basic", "load_rom", "tape_control"]],
    ["Running", ["run", "pause", "run_until_prompt", "run_frames", "run_for_cycles", "run_to", "step"]],
    ["Breakpoints and watchpoints", ["set_breakpoint", "clear_breakpoint", "list_breakpoints", "set_watchpoint", "clear_watchpoint", "list_watchpoints", "set_break_on_interrupt", "get_log"]],
    ["Memory and the CPU", ["read_memory", "write_memory", "save_memory", "set_paging", "get_registers", "set_registers", "disassemble", "evaluate"]],
    ["The screen", ["get_screen", "get_screen_text"]],
    ["The keyboard", ["type_text", "key_down", "key_up", "press_key", "keyboard_state", "release_all_keys"]],
    ["Saved states", ["save_state", "restore_state", "list_states", "delete_state", "save_snapshot", "load_snapshot"]],
    ["Sound", ["get_sound_state", "sound_capture"]],
    ["Symbols", ["load_debug_info", "resolve_symbol", "resolve_address"]],
];

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tools = makeTools({}, () => ({}));
const listed = new Set(Groups.flatMap(([, names]) => names));
const unplaced = Object.keys(tools).filter((n) => !listed.has(n));
const unknown = [...listed].filter((n) => !tools[n]);
if (unplaced.length || unknown.length) {
    console.error(`Place these in a group: ${unplaced.join(", ") || "-"}; no such tool: ${unknown.join(", ") || "-"}`);
    process.exit(1);
}

const row = (name) => {
    const t = tools[name];
    const required = new Set(t.inputSchema?.required ?? []);
    const args = Object.keys(t.inputSchema?.properties ?? {}).map((p) => (required.has(p) ? p : `${p}?`));
    return `| \`${name}(${args.join(", ")})\` | ${t.description.replace(/\|/g, "\\|")} |`;
};
const tables = Groups.map(([title, names]) => `### ${title}\n\n| Tool | Does |\n|---|---|\n${names.map(row).join("\n")}\n`).join("\n");

const file = path.join(root, "docs", "mcp.md");
const doc = fs.readFileSync(file, "utf8");
const start = "<!-- tools:start -->";
const end = "<!-- tools:end -->";
if (!doc.includes(start) || !doc.includes(end)) {
    console.error(`docs/mcp.md has no ${start} ... ${end} markers`);
    process.exit(1);
}
const before = doc.slice(0, doc.indexOf(start) + start.length);
const after = doc.slice(doc.indexOf(end));
fs.writeFileSync(file, `${before}\n\n${tables}\n${after}`);
console.log(`docs/mcp.md: ${Object.keys(tools).length} tools in ${Groups.length} groups`);
