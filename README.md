# BBC Micro Debug for VS Code

Debug BBC Micro programs in VS Code on a real emulator, and let AI agents
drive the same machine over MCP. It is the BBC Micro counterpart of
[zx-spectrum-emulator](https://github.com/jonsole/zx-spectrum-emulator), but
the emulator is not new: it is [jsbeeb](https://github.com/mattgodbolt/jsbeeb),
Matt Godbolt's accurate, open source BBC Micro emulator, vendored here and
driven headless.

- **Debugger (DAP):** breakpoints in your BeebAsm or ca65 source, conditional
  and hit-count breakpoints, logpoints, function breakpoints on symbols,
  instruction breakpoints in the disassembly view, data breakpoints (memory
  watchpoints), step in/over/out (interrupt handlers are run through, not
  stepped into), registers and flags you can edit, the 6502 stack, symbols,
  memory view, and a call stack read off the hardware stack. And backwards:
  Step Back and Reverse Continue go back through the last minute of what
  the machine did, exactly.
- **MCP server:** over 60 tools for Claude Code, VS Code's agent mode, or
  any MCP client, modelled on [jsbeeb-mcp](https://github.com/mattgodbolt/jsbeeb-mcp)'s
  interface: run BASIC in one call, run until the prompt or for N frames and
  get back what was printed, press keys on the keyboard matrix by name or
  internal number, save and restore states, read the sound chip, plus
  breakpoints, watchpoints, stepping forwards and back ("who wrote that?"),
  memory, registers, disassembly, screenshots, an execution trace, a
  profiler, video recording and sound measurement. A debugger window and an
  agent share the one machine.
- **Screen panel:** the live display with the BBC's keyboard and its sound,
  plus BREAK, power cycle, pause and warp. It follows the debug session
  you pick, and **Show Screen of…** opens one on any emulator running.
- **Programs:** disc images (`.ssd`, `.dsd`, booted with SHIFT-BREAK), tapes
  (`.uef`, CHAINed), BBC BASIC source (`.bas`, tokenised and RUN), and raw
  binaries (loaded at an address and CALLed).
- **Machines:** BBC Model B (8271 or 1770 disc controller) and BBC Master 128,
  with the ROMs jsbeeb ships.

## How it fits together

```
VS Code ──DAP (TCP 4811)──┐
                          ├── bbc_server (server/main.mjs, Node) ── jsbeeb (vendor/jsbeeb)
MCP client ──HTTP 8811/mcp┤        one BBC Micro, run in real time
screen panel ─HTTP /stream┘
```

The emulator runs in its own Node process, started by the extension with VS
Code's own runtime (nothing to install) the first time it is needed, so a busy
emulator never blocks the editor. The extension only starts it, points VS
Code's debugger and MCP client at it, and shows its screen. If an emulator is
already listening (another window, or one you started by hand), it is used
instead of a second one.

## Getting started

1. Install the extension. From a checkout, the simplest is to link VS Code
   to it, so it runs from the checkout and a window reload picks up changes
   (nothing to build or install first). On Windows, in PowerShell:

   ```powershell
   .\scripts\link-extension.ps1        # -Insiders for VS Code Insiders, -Remove to undo
   ```

   which makes a junction in `%USERPROFILE%\.vscode\extensions`. On macOS or
   Linux, a symlink does the same:
   `ln -s "$PWD" ~/.vscode/extensions/jonsole.bbc-micro-debug-0.1.0`.
   Then restart VS Code. Or install a packaged `.vsix`
   (`npx @vscode/vsce package`, then `code --install-extension`), or open this
   folder and press F5 ("Run Extension").
2. Open `examples/hello` and press F5. The prebuilt disc boots, prints its
   message five times, and stops at any breakpoint you set in `hello.6502`.
   With [BeebAsm](https://github.com/stardot/beebasm) on your PATH, the
   launch configuration reassembles it first.
3. **BBC Micro: Show Screen** opens the display; click it to type.

Right-click a `.ssd`, `.dsd`, `.uef` or `.bas` file in the Explorer to run or
debug it without a launch configuration.

### Source-level debugging with BeebAsm

BeebAsm writes no line numbers, but its `-v` listing has every instruction in
order, which the debugger lines up with your source (following `INCLUDE`s).
Assemble with:

```sh
beebasm -i main.6502 -do build/main.ssd -boot MAIN -v -dd -labels build/main.labels > build/main.lst
```

and launch with:

```jsonc
{
  "type": "bbcmicro",
  "request": "launch",
  "name": "BBC Micro: main",
  "preLaunchTask": "beebasm",
  "program": "${workspaceFolder}/build/main.ssd",
  "debugInfo": ["${workspaceFolder}/build/main.labels", "${workspaceFolder}/build/main.lst"],
  "source": "${workspaceFolder}/main.6502"
}
```

Straight-line code and included files map exactly. Inside a `MACRO`, or a
`FOR` loop's second time round, an address maps to the line that produced its
first copy, or to no line (the disassembly view still works there).

**ca65/ld65:** pass the `--dbgfile` output in `debugInfo` for exact
source lines and symbols. **Anything else:** a VICE label file
(`al C:1900 .start`) or plain `name = &1900` lines give symbols, and you
debug in the disassembly view.

### Launch configuration

| Attribute | |
|---|---|
| `program` | `.ssd`/`.dsd`/`.adf` or a zip (SHIFT-BREAK), `.uef` (`*TAPE`, `CHAIN""`), `.bas` (RUN), or a raw binary; a disc can also be `sth:Acornsoft/Elite.zip` or a URL |
| `model` | `B-DFS1.2` (default), `B-DFS0.9`, `B1770`, `B1770A`, `Master`, `MasterADFS`, `MasterANFS` |
| `tube` | Fit the second processor (65C02, or the Master's 65C102 Turbo) |
| `romBank` | For a sideways ROM: the bank (0-15) its code at `&8000`-`&BFFF` is in, so its breakpoints there stop only in that bank |
| `loadAddress`, `execAddress` | Raw binaries: where it goes, where it starts (`&1900`, `$1900`, `0x1900`) |
| `run` | What to type to start it instead, e.g. `"*RUN GAME"` or `"CHAIN \"MENU\""` |
| `debugInfo`, `source` | Symbols and line info, as above |
| `stopOnEntry` | Stop as soon as the program starts |
| `stopAt` | Stop on arrival at an address or symbol |
| `ports` | Which emulator: `"auto"` a new one for this session alone, on free ports; `{ "dap": 4812, "http": 8812 }` the one on those ports (started if need be); left out, the usual one |

`attach` debugs whatever the machine is doing now, without resetting it.

Two sessions on the same emulator are two views of one machine, so to debug
two programs at once give one `"ports": "auto"` (the snippet **BBC Micro:
Launch on a new emulator**). The screen panel shows the emulator of the
session picked in the Call Stack view.

### Expressions

Breakpoint conditions, the Watch pane, hovers, and the Debug Console take the
same expressions: registers `A X Y S P PC`, flags `C Z I D V N`, symbols,
`?addr` for a byte and `peekw(addr)` for a word, numbers as `&1900`, `$1900`,
`0x1900`, `%1010` or decimal, and both C and BBC BASIC operators
(`= <> AND OR EOR NOT MOD`). Since `&F0` is a number, write `A AND &F0`, not
`A&F0`. A logpoint message puts expressions in braces: `counter is {?counter}`.

In the Debug Console, a line starting with `>` is typed at the BBC's keyboard:
`>*CAT`, `>RUN`.

### Keyboard

Keys go to the BBC by position, through jsbeeb's keyboard map: SHIFT, CTRL,
Caps Lock as themselves; Backspace and Delete are DELETE; End and F11 are
COPY; F10 is f0; Escape is ESCAPE; F12 is BREAK.

## MCP

Point any MCP client at `http://127.0.0.1:8811/mcp` (streamable HTTP). This
repository's `.mcp.json` does that for Claude Code; elsewhere:

```sh
claude mcp add --transport http bbc-micro http://127.0.0.1:8811/mcp
```

or **BBC Micro: Copy MCP Setup for Claude Code…**. In VS Code's own agent
mode the extension registers the server itself and starts the emulator when
the agent first uses it. Other clients need the emulator running: start it
from VS Code (**BBC Micro: Start the Emulator**) or by hand with
`node server/main.mjs`.

See [docs/mcp.md](docs/mcp.md) for the tools.

## Running the server by hand

```sh
node server/main.mjs [--dap-port 4811] [--http-port 8811] [--model Master] [--warp] [--paused] \
                     [--program game.ssd] [--load-address &1900 --exec-address &1900] [--ffmpeg PATH]
```

Node 22 or later. A port of 0 takes any free one, which the first line it
prints says. Besides `/mcp`, it serves `/screen.png` (a screenshot), `/stream`
(the screen panel's frame stream) and `/audio` (its sound, 16-bit mono at
44.1kHz). `--ffmpeg` names the ffmpeg `start_video` uses, if it is not on the
PATH.

## Development

No build step. The server is ES modules in `server/`, the extension CommonJS
in `extension/`.

```sh
npm test                          # unit tests, and DAP and MCP end to end against a real server
npm install && xvfb-run -a npm run test:vscode   # the extension inside a real VS Code
```

`vendor/jsbeeb` is a copy of jsbeeb's source, refreshed with
`node scripts/update-jsbeeb.mjs <jsbeeb-checkout>`; see
[vendor/jsbeeb/VENDORED.md](vendor/jsbeeb/VENDORED.md) for the version. Don't
edit it: wrap it in `server/` instead. [AGENTS.md](AGENTS.md) has more for
anyone (or anything) working on the code.

## Licence

GPL-3.0-or-later, because jsbeeb is. The BBC Micro and Master ROM images in
`vendor/jsbeeb/public/roms` are not GPL: they are Acorn's copyright, carried
as jsbeeb carries them (see the README there). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
