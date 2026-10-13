# AGENTS.md

Guidance for coding agents working in this repository. What the project is
and how to use it: [README.md](README.md) and [docs/](docs/).

## The short version

- **The emulator is jsbeeb, vendored in `vendor/jsbeeb/`.** Don't edit it.
  Refresh it with `node scripts/update-jsbeeb.mjs <jsbeeb-checkout>` (it
  copies only what `src/index.js` and `src/snapshot.js` reach, plus the
  ROMs); change behaviour by wrapping it in `server/`. A jsbeeb bug is fixed
  upstream, then re-vendored.
- **`server/` is the debugger and MCP server** (Node 22+, ES modules, 4-space
  indent like jsbeeb). **`extension/` is VS Code's side** (CommonJS, 2-space
  indent, like the ZX Spectrum extension). No build step for either.
- **GPL-3.0-or-later**, because jsbeeb is.

## Build and test

```sh
npm test                                         # ~10s: unit tests + DAP and MCP end to end
npm install && xvfb-run -a npm run test:vscode   # the extension in a real VS Code (downloads it once)
BBC_TEST_SCREENSHOT=/tmp/shot.png xvfb-run -a -s "-screen 0 1600x1000x24" npm run test:vscode
                                                 # ... and a screenshot of the window mid-debug
```

The end-to-end tests start a real `server/main.mjs` on free ports
(`tests/helpers.mjs`) and talk DAP and MCP to it. Check a behaviour change
that way rather than only by unit test: stepping, stops and loading are only
really observable through the protocols.

After changing an MCP tool, `node scripts/mcp-docs.mjs` rewrites
`docs/mcp.md`'s tool tables from the definitions; a new tool must be put in
one of its groups.

`examples/hello/build/` is checked in so tests and the example run without
BeebAsm. If you change `hello.6502`, rebuild it with the command at its top.

## Where things are

| Path | What |
|---|---|
| `server/engine.mjs` | The one live machine: the real-time run loop, stepping, breakpoints, watchpoints, logpoints, call stack, screen, keys, snapshots |
| `server/rewind.mjs` | The recent past: checkpoints, replay to an exact cycle, and the searches stepping backwards makes |
| `server/trace.mjs`, `server/profiler.mjs` | The execution trace file, and the profile |
| `server/video.mjs`, `server/audio.mjs` | Recording the screen through ffmpeg; the sound, measured and streamed |
| `server/registry.mjs` | Where running emulators advertise themselves, for Show Screen of… |
| `server/vdu_transcript.mjs`, `server/screen_text.mjs` | What was printed, and what the screen says now |
| `server/program.mjs` | Loading a disc, tape, BASIC or binary and starting it (shared by DAP launch and MCP `load_program`) |
| `server/dap.mjs` | The Debug Adapter Protocol over TCP |
| `server/mcp.mjs` | The MCP tools; every tool is declared here only |
| `server/debug_info.mjs` | Symbols and source lines: BeebAsm labels and listing, ca65 `.dbg`, VICE labels |
| `server/expr.mjs` | The expression language for conditions, watches and MCP `evaluate` |
| `server/screen_stream.mjs` | The screen panel's frame stream |
| `server/main.mjs` | Command line, HTTP routes, startup |
| `extension/` | Starting the server, the debugger and MCP registration, the screen panel, BeebAsm syntax |

## Things that bite

- **Everything goes through the Engine.** The DAP and MCP front ends never
  touch jsbeeb directly, and both learn about stops from the Engine's
  `stopped` event. A run the server makes for itself (booting, loading,
  `run_for`) is marked `internal`, and DAP does not announce its stops.
- **jsbeeb's debug hook runs before an instruction**, and returning true stops
  the CPU *before* it executes; `cpu.breakpointResume` skips the hook for the
  first instruction of the next `execute`, which is how continuing from a
  breakpoint does not stop on it again. The Engine sets it on every resume.
  Read and write hooks stop the CPU *after* the instruction finishes.
- **Hooks cost speed.** jsbeeb takes a slower path while any hook is
  installed; the Engine installs them only while something needs them.
- **Reading I/O has side effects.** Use `engine.peek()` (jsbeeb's `peekmem`),
  which reads I/O as `&FF`, for anything a debugger shows.
- **BREAK is not a key** in jsbeeb's matrix; F12 means BREAK only because the
  Engine treats it so.
- **jsbeeb logs with `console.log`.** The server sends it to stderr, because
  stdout carries the one readiness line the extension waits for.
- **Anything done to the machine from outside goes through the Engine and
  calls `_mutated()`**, which checkpoints it into the history: that is how
  the past replays it, and how doing it in the past starts a new timeline.
  A new way to change the machine that skips it makes the past replay wrong.
  Anything that moves the cycle count backwards (a restore) resets the
  history instead.
- **Replay relies on jsbeeb being deterministic**: no `Math.random` or wall
  clock in a BBC's run (the Master's clock is pointed at emulated time),
  and the keyboard and typist, which snapshots leave out, saved beside them.
- A program started by SHIFT-BREAK can finish before the SHIFT key is
  released, so a launch's `stopAt` is a breakpoint from the moment the
  program is loaded, not something run to afterwards.
