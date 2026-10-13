# The MCP server

Part of the [README](../README.md).

The emulator serves MCP (streamable HTTP) at `http://127.0.0.1:8811/mcp`
(`--http-port` or the `bbcMicro.httpPort` setting moves it). It is the same
machine VS Code debugs: a stop an agent causes shows up in VS Code's call
stack, and a breakpoint VS Code sets stops an agent's `run`. Each side's
breakpoints are its own: `clear_breakpoint` removes only MCP's, and ending a
debug session removes only that session's.

Registering the server does not start it. VS Code's agent mode starts it
through the extension; any other client needs it running first (**BBC Micro:
Start the Emulator**, opening the screen, a debug session, or
`node server/main.mjs`). If it is not running, the client shows the server as
failed: start it and reconnect (`/mcp` in Claude Code).

Addresses can be written `&1900` (BBC style), `$1900`, `0x1900`, `6400`, a
symbol from the program's debug info, or an expression (`table+2`). See
[Expressions](../README.md#expressions).

## Tools

| Tool | Does |
|---|---|
| `server_info()` | Which emulator this is: its version, the emulated model, the ports it serves DAP, MCP and the screen on, and the program last loaded. |
| `get_state()` | The machine at a glance: running or stopped and why, registers and flags, the instruction at PC, breakpoints, watchpoints, a guess at the call stack, and cycles and frames run. |
| `load_program(path, model?, load_address?, exec_address?, run?, boot?, debug_info?, source?, stop_at?)` | Reset the machine and load a program from a file on this computer, then start it. .ssd/.dsd discs boot with SHIFT-BREAK; .uef tapes are CHAINed; .bas files are BBC BASIC source, tokenised and RUN; anything else is a raw binary that needs load_address (and exec_address if it is not entered at the start). The machine is left running unless stop_at is given or a breakpoint is hit. |
| `reset(hard?, model?)` | Reset the machine: a power-on (hard) reset by default, or BREAK (hard: false). With model, switch to that model first. Leaves it running. |
| `run(wait_ms?)` | Let the machine run (in real time) until a breakpoint, a watchpoint or pause. With wait_ms, wait that long for it to stop and say why. |
| `run_for(seconds?, frames?)` | Run for a span of emulated time as fast as possible, then stop: the quickest way to let a program get somewhere. Breakpoints still stop it early. |
| `pause()` | Stop a running machine. |
| `step(count?, mode?)` | Execute instructions and stop. mode "into" (default) runs `count` instructions; "over" runs a JSR to its return; "out" runs to the RTS of the current subroutine. Interrupt handlers are run through as if one instruction. |
| `run_to(address, timeout_seconds?)` | Run until PC reaches an address (a one-off breakpoint), as fast as possible, giving up after timeout_seconds of emulated time. |
| `set_breakpoint(address, condition?, hit_count?, log_message?)` | Stop when execution reaches an address. condition is an expression (e.g. "A=&41", "?&70>3", "X<>0 AND C"); log_message makes it a logpoint that records a message ({expressions} in braces) instead of stopping. |
| `clear_breakpoint(address?)` | Remove MCP's breakpoint at an address, or all of them if no address is given. |
| `list_breakpoints()` | Every breakpoint and logpoint set, by MCP or by VS Code, with hit counts. |
| `set_watchpoint(address, length?, access?, condition?)` | Stop when the program reads or writes memory in a range: what changed this? The machine stops after the instruction that did it. condition can test `value`, the byte read or written. |
| `clear_watchpoint(id?)` | Remove a watchpoint by id, or all of MCP's. |
| `list_watchpoints()` | Every watchpoint, with hit counts. |
| `get_log(since?, max?)` | What logpoints have reported, after sequence number `since`. |
| `read_memory(address, length?, bank?)` | Read memory as the CPU sees it (I/O at &FC00-&FEFF reads as &FF rather than disturbing the hardware), as a hex dump. bank reads a sideways ROM/RAM bank at &8000-&BFFF whether or not it is paged in. |
| `write_memory(address, data, bank?)` | Write bytes into memory: data is hex, e.g. "A9 41 20 EE FF 60". |
| `get_registers()` | The 6502's registers and flags. |
| `set_registers(pc?, a?, x?, y?, s?, p?, c?, z?, i?, d?, v?, n?)` | Change registers or flags while stopped: any of pc, a, x, y, s, p, and the flags c z i d v n (0 or 1). Values may be expressions or symbols. |
| `disassemble(address?, count?)` | Disassemble instructions from an address (default PC), with symbols. |
| `evaluate(expression)` | Evaluate an expression: registers (A X Y S P PC, flags C Z ...), symbols, ?addr for a byte, peekw(addr) for a word, BBC BASIC or C operators. |
| `get_screen()` | A screenshot of the BBC's display, as a PNG image. |
| `get_screen_text(clear?)` | The text the program has printed through the OS (OSWRCH), laid out as on screen, in any mode. Programs that write straight to screen memory don't show here: use get_screen for those. |
| `type_text(text, enter?)` | Type text at the BBC keyboard, followed by RETURN unless enter is false: BASIC lines, *commands, answers to prompts. Waits until it has all been typed. |
| `key_down(key)` | Hold a key down: a name (RETURN, SHIFT, CTRL, ESCAPE, SPACE, DELETE, COPY, CAPS LOCK, F0-F9, LEFT, UP, ...), a letter or digit, or a KeyboardEvent.code ("KeyZ"). |
| `key_up(key)` | Release a key held with key_down. |
| `press_key(key, frames?)` | Press and release a key, holding it for `frames` frames of emulated time (default 5); the machine runs meanwhile. |
| `load_debug_info(files, source?, replace?)` | Load symbols (and source lines) for the program: BeebAsm -labels output, a BeebAsm -v listing with its source file, a ca65 .dbg, or a VICE label file. Adds to what is loaded unless replace is true. |
| `resolve_symbol(name)` | A symbol's address. |
| `resolve_address(address)` | The nearest symbol to an address, and its source line if known. |
| `save_snapshot(path)` | Save the whole machine to a file, in jsbeeb's snapshot format, disc contents included. |
| `load_snapshot(path)` | Restore the machine from a snapshot file saved by save_snapshot or by jsbeeb. Leaves it stopped. |

`?` marks an optional argument. The table is generated from `server/mcp.mjs`
(`tools/list` gives the full schemas).

## A typical session

1. `load_program(path="…/build/game.ssd", debug_info=[…labels, …lst], source="…/game.6502", stop_at="main")`
2. `get_screen()` to see it, `get_screen_text()` for what it printed.
3. `set_watchpoint(address="lives", access="write")`, `run(wait_ms=10000)`:
   which instruction changes the lives counter?
4. `get_state()`, `disassemble()`, `step(mode="over")`.
5. `press_key(key="Z", frames=10)` or `type_text(text="RUN")` to play it.

## Notes

- The machine runs in real time (`run`); `run_for`, `run_to`, `step` and
  loading run as fast as they can.
- Reading memory never touches I/O: `&FC00`–`&FEFF` reads as `&FF` rather
  than clearing a VIA's flags.
- `get_screen_text` follows what the program printed through OSWRCH, laid out
  as the screen is; it does not see a program writing to screen memory
  directly. `get_screen` always does.
- Snapshots are in jsbeeb's own snapshot format, with the disc's contents
  kept in them, so the file alone brings the machine back.
