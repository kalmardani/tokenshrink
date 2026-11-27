# ADR 0007. Starting vendor CLIs on Windows without shell: true

## Status
Accepted, 2026-11-27

## Context
npm installs the `claude` and `codex` CLIs on Windows as `.cmd` shims. CreateProcess cannot start
a `.cmd` file directly, and Node refuses to spawn one without `shell: true`. A shell built from
string concatenation would let any argument with `&`, `|` or `%` run other commands.

## Decision
- The command is resolved like Windows does it, through PATH and PATHEXT.
- An `.exe` or `.com` is spawned directly with an argument array.
- A `.cmd` or `.bat` is started as `cmd.exe /d /s /c "<line>"` with `windowsVerbatimArguments`.
  Every argument is wrapped in quotes, trailing backslashes are doubled, and every cmd
  metacharacter, the quotes included, gets a caret, so cmd sees no unescaped special character.
  `/d` skips AutoRun commands.
- Arguments that cmd cannot carry safely are refused before spawning, which are `%`, `"`, line
  breaks and NUL. tokenshrink's own arguments are fixed flags, a model name checked against a
  strict pattern and temp file paths. The system prompt and the user prompt never travel as
  arguments, the prompt goes on stdin and the claude system prompt through
  `--system-prompt-file`.
- On timeout the whole process tree is ended with `taskkill /T /F`, because killing cmd.exe alone
  would leave the CLI running.

## Consequences
- No `shell: true` anywhere, on any platform.
- A temp dir path that contains `%` would be refused on Windows. That is rare and fails closed
  with a clear message.
- The quoting is covered by unit tests on every OS. It has not been run against a real `.cmd`
  shim on a Windows machine at the time of writing.
