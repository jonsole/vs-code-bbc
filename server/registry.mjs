// Where running emulators say they are: a small JSON file each, named by
// process id, in a directory every emulator on this machine shares. The
// extension reads it to offer the screen of any of them -- started by a
// window, a task, a terminal or an MCP client -- and server_info says where
// this one's file is. A file is removed when its emulator exits; one left by
// an emulator that crashed (or was killed, on Windows) is recognised by its
// process being gone, and removed then.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RegistryDir = path.join(os.tmpdir(), "bbc-micro-emulators");

export function advertise(entry) {
    const file = path.join(RegistryDir, `${process.pid}.json`);
    try {
        fs.mkdirSync(RegistryDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(entry, null, 2));
    } catch {
        return null; // nowhere to say so: it still runs
    }
    process.on("exit", () => {
        try {
            fs.unlinkSync(file);
        } catch {
            // already gone
        }
    });
    return file;
}

/** Every emulator advertised whose process is still there. */
export function listAdvertised() {
    let names = [];
    try {
        names = fs.readdirSync(RegistryDir).filter((n) => n.endsWith(".json"));
    } catch {
        return [];
    }
    const out = [];
    for (const n of names) {
        try {
            const entry = JSON.parse(fs.readFileSync(path.join(RegistryDir, n), "utf8"));
            process.kill(entry.pid, 0);
            out.push(entry);
        } catch (e) {
            // Unreadable, or its process has gone, when the file goes too: on
            // Windows a killed emulator cannot take it away itself, and its pid
            // may soon be another process's.
            if (e.code === "ESRCH") fs.rmSync(path.join(RegistryDir, n), { force: true });
        }
    }
    return out;
}
