# The MCP server

Part of the [README](../README.md).

The emulator serves MCP (streamable HTTP) at `http://127.0.0.1:8811/mcp`
(`--http-port` or the `bbcMicro.httpPort` setting moves it). It is the same
machine VS Code debugs and the screen panel shows: a stop an agent causes
shows up in VS Code's call stack, and a breakpoint VS Code sets stops an
agent's run. Each side's breakpoints are its own: `clear_breakpoint` removes
only MCP's, and ending a debug session removes only that session's.

## Where the interface comes from

The tools follow [jsbeeb-mcp](https://github.com/mattgodbolt/jsbeeb-mcp), the
MCP server jsbeeb's author wrote for it, wherever it fits:

- **Run tools that hand back what was printed.** `run`,
  `run_until_prompt`, `run_frames`, `run_for_cycles`, `run_to`, `step`,
  `type_text`, `press_key` and `run_basic` all wait, and all report the same
  way: `completed`, and if not, `stopped_reason` (`breakpoint`, `watchpoint`,
  `timeout`, ...) and `stopped`, with a `watch_stop` for a watchpoint;
  `registers` with `frame_count` and `elapsed_cycles`; `cycles_run` and
  `frames_run`; and `output`, what was printed since output was last taken.
  `clear: false` peeks without taking it. These results also come as typed
  `structuredContent`, their shape declared as the tool's `outputSchema`.
- **Nothing hangs.** Every one of them has a bound: `run` stops after
  `timeout_secs` of emulated time (30 by default) with `stopped_reason:
  "timeout"`, so a breakpoint that is never hit cannot hang the client.
- **`run_frames` stops on the paint itself**, so one call is one new picture;
  a frame is 40000 cycles interlaced and 39936 not, so stepping by cycles
  drifts against the display.
- **Keys on the keyboard matrix**, by the machine's own name (`SHIFT`,
  `RETURN`, `COLON_STAR`, `K1`), by internal key number (as `OSBYTE 121`
  and a game's own scan use), by negative INKEY number, or by column and row:
  exactly the key a game reads, with no host keyboard layout in between.
  `keyboard_state` and `release_all_keys` keep it in a known state.
- **Saved states held server-side**: `save_state` once a machine is set up,
  `restore_state` between attempts; only the id crosses the connection.
- **Paged memory**: reads report `romsel` (and a Master's `acccon`), and
  `bank` and `shadow` reach a particular sideways bank or shadow RAM.
- **Discs from anywhere jsbeeb finds them**: files, zips, URLs, and the
  Stairway to Hell and BBC disc archives (`sth:Acornsoft/Elite.zip`).
- **The sound chip**: its registers, and a decoded log of every write.
- **`run_basic`** for trying a BASIC program in one call.

## Two kinds of text

- **`output`**, in the run tools' reports, answers *what did that print?* It
  is a transcript of what went through OSWRCH, in order: newlines as
  newlines, a form feed (`\f`) where CLS or MODE cleared the screen, VDU
  parameters (colours, `VDU 31` positions) left out. Being in order, text
  from before a clear never mixes with text after it.
- **`get_screen_text`** answers *what does the screen say now?* It reads
  screen memory: MODE 7 exactly, the other modes by matching each character
  cell against the font (inverse text too), with `·` for a cell that is not
  a character. It is right after a CLS or a scroll, and for programs that
  write the screen themselves.

It differs on purpose in one thing: **there are no sessions** and no
`create_machine`. There is one machine, shared with VS Code, so an agent and
a person can work on the same thing. Where the ZX Spectrum emulator has a
tool for the same job, the name is the ZX one (`get_screen` rather than
`screenshot`, `get_registers`, `type_text`), and the debugging tools
(`step`, conditional breakpoints, logpoints with formats such as `{A:d}`,
watchpoints that stop only on a change or on a value and say what did it,
screen sequences, `disassemble` with symbols and source lines, `evaluate`)
come from there.

With VS Code debugging the same machine, a stop an agent causes shows in its
call stack without taking the editor over, and a tool that resets the machine
(`reset`, `load_program`, `run_basic`, `restore_state`, `load_snapshot`) adds
a `warning` saying so.

## Sideways banks

`&8000`-`&BFFF` is whichever of the 16 sideways ROM/RAM banks is paged in,
so an address there can name its bank: `"4:&8000"`, or `bank` beside it. A
breakpoint, watchpoint or logpoint with a bank fires only while that bank is
paged in there; without one, whatever is, as before. Reported addresses in
that range carry the bank paged in (`"5:&8102"`). `read_memory` and
`write_memory` reach a bank without paging it in, `set_paging` pages one in,
and `load_rom` puts a sideways ROM image into a bank. Debug info for a
sideways ROM takes the bank its code is in (`load_debug_info(bank)`, or
`romBank` in a VS Code launch configuration), so its symbols and source
breakpoints are that bank's alone.

## Going back

The machine keeps its recent past, about the last minute of emulated time,
so an agent can go back to any instant in it exactly as it was: memory,
registers, the screen, the disc. `step_back` goes back `"into"` the previous
instruction, `"over"` (the default) the previous one in this routine, or
`"out"` to the JSR that entered it, passing over interrupt handlers as `step`
does. `reverse_continue` goes back to the last breakpoint hit or watchpoint
access, `run_back_to` to the last time execution reached an address, and
`run_back_to_write` to the instruction that last wrote one, before it runs:

```
set_watchpoint {address: "lives"}     # what took a life?
run                                   # -> watch_stop: &0E05 3 -> 2 by &1F3A
run_back_to_write {address: "lives"}  # just before the write, with its call stack
```

Each answers with `moved` (false, with a `note`, when nothing earlier
matches), the registers, the call stack, `in_past` and `behind_cycles`.
From the past, `step` and `run` replay what happened, keys and typing
included; a key, a `write_memory`, `set_registers` or anything else done to
the machine there starts a new timeline, and what came after is dropped.
`return_to_live` replays to the newest instant. A power-on, a load, a
`restore_state` or `load_snapshot` starts the history again, and while a tape
is playing there is none (a moving tape is not in jsbeeb's snapshots).
`history_status` says how much there is. VS Code's Step Back and Reverse
Continue buttons do the same.

## Starting it

Registering the server does not start it. VS Code's agent mode starts it
through the extension; any other client needs it running first (**BBC Micro:
Start the Emulator**, opening the screen, a debug session, or
`node server/main.mjs`). If it is not running, the client shows the server as
failed: start it and reconnect (`/mcp` in Claude Code).

Addresses can be written `&1900` (BBC style), `$1900`, `0x1900`, `6400`, a
symbol from the program's debug info, or an expression (`table+2`). See
[Expressions](../README.md#expressions).

## Tools

`?` marks an optional argument. These tables are generated from
`server/mcp.mjs`; `tools/list` gives the full schemas.

<!-- tools:start -->

### The machine

| Tool | Does |
|---|---|
| `server_info()` | Which emulator this is: its version, the emulated model, the ports it serves DAP, MCP and the screen on, and the program last loaded. |
| `get_state()` | The machine at a glance: running or stopped and why, registers and flags, the instruction at PC, breakpoints, watchpoints, a guess at the call stack, and cycles and frames run. |
| `reset(hard?, autoboot?, model?, tube?)` | Reset the machine: power-on (hard, the default) or BREAK (hard: false); model or tube switch to another machine first. autoboot holds SHIFT through the reset (SHIFT-BREAK) to boot the disc in drive 0, and reports shift_held_at_reset. Typing still pending is dropped (cancelled_typing). Leaves the machine running. |
| `set_speed(speed?, multiplier?)` | How fast the machine runs while it runs on its own (run, the screen panel): "realtime" (a real 2MHz BBC) or "uncapped" (as fast as the host goes), and a multiplier on real time -- 0.1 a tenth, 0.001 slow enough to watch single writes land, 2 double. The tools that run to somewhere (run_frames, run_until_prompt, step...) always run flat out. |

### Loading

| Tool | Does |
|---|---|
| `load_program(path, model?, tube?, load_address?, exec_address?, run?, boot?, debug_info?, source?, rom_bank?, stop_at?)` | Reset the machine, load a program and start it: the usual way in. .ssd/.dsd/.adf discs (or a zip, or a disc reference as load_disc takes) boot with SHIFT-BREAK; .uef tapes are CHAINed; .bas files are BBC BASIC source, tokenised and RUN; anything else is a raw binary, which needs load_address. Left running unless stop_at is given or a breakpoint stops it. |
| `load_disc(image, drive?)` | Put a disc in a drive without resetting or booting: from a file here (.ssd, .dsd, .adf, or a zip holding one), a file: or http(s): URL, 'sth:Acornsoft/Elite.zip' (Stairway to Hell), or 'hfe:<path>' (the BBC disc archive). Then type_text '*CAT', '*RUN NAME' or 'CHAIN"NAME"'; a disc in drive 1 is ':1.NAME'. |
| `load_basic(source)` | Tokenise BBC BASIC source and put it at PAGE, as if typed in. Does not run it: type_text RUN, then run_until_prompt. |
| `run_basic(source, model?, timeout_secs?, screenshot?)` | One step for trying BASIC: reset the machine, load the program, RUN it until it waits at a prompt (or timeout_secs of emulated time pass), and return what it printed and a screenshot. The machine is left stopped where the program finished. |
| `load_rom(path, bank, reset?)` | Put a sideways ROM (or RAM) image, up to 16K, into a bank 0-15, from a file. The MOS finds sideways ROMs at a reset, so by default this resets the machine afterwards (a BREAK; reset: false leaves that to you), and the ROM's *commands and service calls work from then on. |
| `tape_control(action?)` | The cassette recorder, for a tape load_program put in: "play", "stop", "rewind", "eject", or "status" (the default). Every reply says what is in it, how far through (0 to 1), and whether PLAY is down, the motor relay on and the tape moving -- the tape moves only while both are. Takes effect at once, mid-run included. |

### Running

| Tool | Does |
|---|---|
| `run(wait?, timeout_secs?)` | Let the machine run on in real time, as the screen panel shows it, until a breakpoint, a watchpoint or pause, and report how it stopped -- or after timeout_secs of emulated time (default 30), stopped_reason "timeout", so a breakpoint that is never hit cannot hang the call. wait: false starts it and returns at once, to leave a game running. |
| `pause()` | Stop a running machine where it is. |
| `run_until_prompt(timeout_secs?, clear?)` | Run until the machine waits for a key: back at the BASIC or * prompt, or a program's INPUT or GET. The way to let something typed (RUN, a *command) finish. Returns what was printed since output was last taken. Anything still being typed is typed first. |
| `run_frames(count?, clear?)` | Run until another `count` frames have been painted, stopping on the paint itself: one frame is one new picture for get_screen. Use this, not run_for_cycles, to step animation, catch flicker, or let a game move on. Reports frames_run and frame_count, which only climbs. |
| `run_for_cycles(cycles, clear?)` | Run for a number of CPU cycles (2MHz on a BBC): exact timing, to within the instruction that finishes it. Not for stepping the display (a frame is 40000 cycles interlaced, 39936 not): use run_frames. Reports cycles_run. |
| `run_to(address, timeout_seconds?)` | Run until PC reaches an address (a one-off breakpoint), giving up after timeout_seconds of emulated time. |
| `step(count?, mode?)` | Execute instructions and stop. mode "into" (default) runs `count` instructions; "over" runs a JSR to its return; "out" runs to the RTS of the current subroutine. An interrupt taken meanwhile is run through as if it were one instruction. |

### Going back

| Tool | Does |
|---|---|
| `step_back(mode?, count?)` | Go back through what the program did, to an instant exactly as it was: mode "into" the previous instruction executed, "over" (the default) the previous one in this routine, passing back over a subroutine just returned from, "out" the JSR that entered this routine; `count` times. Interrupt handlers are passed over. The history is about the last minute of emulated time, started again by a power-on, a load or a state put back. Forward from the past, step and run replay what happened; a key, a write_memory or set_registers there starts a new timeline. |
| `reverse_continue()` | Go back to the last breakpoint hit, or watchpoint access, before where the machine is; with none in the history, to its start. |
| `run_back_to(address, bank?)` | Go back to the last time execution reached an address (in &8000-&BFFF, with that sideways bank paged in if one is named). |
| `run_back_to_write(address)` | Go back to the instruction that last wrote an address, stopped just before it runs, so one step shows the write: who wrote that? `write` says what it wrote, over what, and from where. |
| `return_to_live()` | From the past, replay to the newest instant recorded: the present the machine left to go back. |
| `history_status()` | How much history there is to go back through and where the machine is in it: live, behind_cycles, frames_behind, frames_available, seconds_available, checkpoints and bytes. |

### Breakpoints and watchpoints

| Tool | Does |
|---|---|
| `set_breakpoint(address, bank?, condition?, hit_count?, log_message?)` | Stop when execution reaches an address. condition is an expression ("A=&41", "?&70>3", "X<>0 AND C"); hit_count waits for the nth hit; log_message makes a logpoint that records a message ({expressions} in braces) instead of stopping. To stop on a read or write of memory, set_watchpoint. |
| `clear_breakpoint(address?, bank?, id?)` | Remove one of MCP's breakpoints, by address (and bank, for a banked one) or by id; with neither, all of them. |
| `list_breakpoints()` | Every breakpoint and logpoint set, by MCP or by VS Code, with hit counts. |
| `set_watchpoint(address, bank?, length?, access?, on_change?, value?, not_value?, condition?)` | Stop when the program reads or writes memory in a range: what changed this? By default only a write that CHANGES the value stops it (on_change false: every write). value / not_value: only an access of, or not of, that byte; condition: any expression, with `value` the byte. The stop comes after the instruction that did it, and the run report's watch_stop says the address, the old and new values and the instruction. |
| `clear_watchpoint(id?)` | Remove a watchpoint by id, or all of MCP's. |
| `list_watchpoints()` | Every watchpoint, with hit counts. |
| `set_break_on_interrupt(enabled)` | Stop a run at the first instruction of the interrupt handler each time the CPU takes an interrupt (IRQ or NMI): for seeing what a handler does, or what it interrupted. The stop's reason is interrupt, and it says where the interrupt came from. |
| `get_log(since?, max?)` | What logpoints have reported, after sequence number `since`. |

### Memory and the CPU

| Tool | Does |
|---|---|
| `read_memory(address, length?, bank?, shadow?)` | Read memory as the CPU sees it, as a hex dump, with paging: romsel (the sideways bank at &8000-&BFFF) and on a Master acccon, so a read of paged memory says which bank it came from. bank or shadow read a particular one instead. I/O at &FC00-&FEFF reads as &FF rather than disturbing the hardware. |
| `write_memory(address, data, bank?, shadow?)` | Write bytes into memory: data is hex ("A9 41 20 EE FF 60") or an array of numbers. bank and shadow as for read_memory. |
| `save_memory(address, length, path, bank?, shadow?)` | Save a range of memory to a file on this computer: quicker than read_memory for big dumps. bank and shadow as for read_memory. |
| `set_paging(bank?, acccon?)` | Change what is paged in, as a debugger: bank, the sideways ROM/RAM bank at &8000-&BFFF (ROMSEL), and on a Master acccon, its ACCCON byte (shadow RAM and the rest). Name only what should change. read_memory and write_memory with a bank reach one without changing what is paged. |
| `get_registers()` | The 6502's registers and flags, the instruction at PC, and the frame and cycle counters. |
| `set_registers(pc?, a?, x?, y?, s?, p?, c?, z?, i?, d?, v?, n?)` | Change registers or flags while stopped: any of pc, a, x, y, s, p, and the flags c z i d v n (0 or 1). Values may be expressions or symbols. |
| `disassemble(address?, count?)` | Disassemble instructions from an address (default PC), with symbols and source lines where known. |
| `evaluate(expression)` | Evaluate an expression: registers (A X Y S P PC, flags C Z ...), symbols, ?addr for a byte, peekw(addr) for a word, BBC BASIC or C operators. |

### The screen

| Tool | Does |
|---|---|
| `get_screen(scale?, frames?, every?)` | A screenshot of the last complete frame, as a PNG, with its frame number so a new picture can be told from the same one twice. frames > 1 gives that many frames, `every` frames apart (default 1; 50 is a second), each an image tagged with its frame number and time: motion, flicker and animation as still pictures. Taking a sequence runs the machine and leaves it stopped at the last. scale 2 doubles each picture. |
| `get_screen_text()` | What the screen says now, as rows of text, read from screen memory: MODE 7 exactly, other modes by matching each character cell against the font (inverse text too). A cell that is not a character -- a sprite, graphics, a user-defined character -- shows as ·. Right after a CLS or a scroll, and for programs that write the screen themselves. What was printed, in order, is the run tools' `output` instead. |

### The keyboard

| Tool | Does |
|---|---|
| `type_text(text, enter?)` | Type text at the keyboard, then RETURN unless enter is false: BASIC lines, *commands, answers to prompts. Waits until it has all been typed (run_until_prompt then lets it finish). A breakpoint can stop it part way: completed is false, and the rest is typed as the machine runs on; until then key_down and key_up refuse, and release_all_keys drops it. |
| `key_down(key?, internal?, inkey?, col?, row?)` | Press and hold a key, straight on the keyboard matrix with no host keyboard layout in between: what a game's own keyboard scan reads. Name it one way: key (the machine's name), internal, inkey, or col and row. Reports the matrix key that went down, with its name and numbers. The machine does not run meanwhile: run, run_frames or press_key let it see the key. |
| `key_up(key?, internal?, inkey?, col?, row?)` | Release a held key, named any way key_down takes. Reports the matrix keys that came up. |
| `press_key(key?, internal?, inkey?, col?, row?, frames?, clear?)` | Press a key (named as key_down takes), hold it for `frames` painted frames (default 5) while the machine runs, and release it. |
| `keyboard_state()` | The keyboard as the machine sees it: every key held, by matrix column and row, name, internal key number and INKEY number; and whether typed text is still pending. |
| `release_all_keys()` | Release every held key and drop any typing still pending, so the keyboard is in a known state. Reports what was released. |

### Saved states

| Tool | Does |
|---|---|
| `save_state(label?)` | Snapshot the whole machine (CPU, RAM, sideways RAM, video, sound, discs, tube) and keep it here under a state_id. Booting and loading are the slow part, so save once and restore_state between attempts. Only the id crosses the connection; free states with delete_state. |
| `restore_state(state_id)` | Put the machine back to a state from save_state (switching model if need be). Memory, registers and the cycle count rewind; breakpoints and the frame counter carry on. Leaves it stopped. |
| `list_states()` | The states save_state holds, newest first. |
| `delete_state(state_id)` | Discard a saved state and free its memory. |
| `save_snapshot(path)` | Save the whole machine to a file, in jsbeeb's snapshot format with the disc contents included, to keep beyond this server's life. |
| `load_snapshot(path)` | Restore the machine from a file saved by save_snapshot. Leaves it stopped. |

### Sound

| Tool | Does |
|---|---|
| `get_sound_state()` | The SN76489 sound chip's registers: each tone channel's period (and frequency) and attenuation, the noise register, the latched register and the LFSR. |
| `sound_capture(action, max_entries?)` | Log every byte written to the sound chip, with its cycle: action "start" (clearing any earlier log), then "stop" to have them back decoded (channel, tone or volume, value), the most recent max_entries (default 500). |

### Symbols

| Tool | Does |
|---|---|
| `load_debug_info(files, source?, replace?, bank?)` | Load symbols (and source lines) for the program: BeebAsm -labels output, a BeebAsm -v listing with its source file, a ca65 .dbg, or a VICE label file. Adds to what is loaded unless replace is true. |
| `resolve_symbol(name)` | A symbol's address. |
| `resolve_address(address)` | The nearest symbol to an address, and its source line if known. |

<!-- tools:end -->

## A typical session

1. `run_basic(source=...)` to try an idea; or
   `load_program(path="…/build/game.ssd", debug_info=[…labels, …lst], source="…/game.6502", stop_at="main")`.
2. `save_state(label="title screen")`.
3. `press_key(key="SPACE")`, `run_frames(count=50)`, `get_screen()`.
4. `set_watchpoint(address="lives")`, `run()`:
   which instruction changes the lives counter? `disassemble()`, `step(mode="over")`.
5. `restore_state(state_id=...)` and try again.

## Notes

- `run` lets the machine go on in real time, as the screen panel shows it.
  Every other run tool runs as fast as it can and leaves the machine stopped.
- Reading memory never touches I/O: `&FC00`-`&FEFF` reads as `&FF` rather
  than clearing a VIA's flags.
- `output` follows what was printed through OSWRCH, so a program writing
  screen memory itself prints nothing there: `get_screen_text` and
  `get_screen` see it.
- `save_snapshot` writes jsbeeb's snapshot format to a file, with the disc
  contents in it; `save_state` keeps states in the server's memory, at most
  100, and they are gone when it stops.
