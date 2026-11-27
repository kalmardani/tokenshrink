# Changelog

All notable changes to this project are listed here. The format follows Keep a Changelog and
the project uses semantic versioning.

## 0.1.1, 2026-11-27

### Changed
- The `claude-cli` and `codex-cli` adapters start the vendor CLI in a fresh, empty folder made
  with `mkdtemp` under the OS temp dir (`tokenshrink-llm-` prefix) and remove it after every
  call, also after an error or a timeout, with retries for Windows. Project instruction files
  of the folder you work in are therefore never sent to the model.
- The MCP server reports the version from package.json.

### Added
- A test that checks, with a fake spawn, that both adapters run in an empty folder inside the
  OS temp dir, never the current directory, and that the folder is gone after the call.

## 0.1.0, 2026-11-27

### Added
- Content type detector for JSON, logs, stack traces, HTML, CSV and TSV, unified diffs and plain
  text.
- One deterministic compressor per type with levels 0 to 4.
- Content addressed store on `node:sqlite` with deflate, handles with line and character spans,
  `expand`, `forget`, `prune` and `stats`.
- Token estimator and budget mode with level escalation and a head and tail fallback.
- Library API, CLI, local HTTP proxy for chat completions, MCP stdio server with `expand`,
  `compress` and `stats`.
- Eval harness with pass@1 and pass^k, scored in code.
- Provider layer with `openai`, `anthropic`, `claude-cli`, `codex-cli` and `fake` adapters, and
  an auth dimension with API keys, an OAuth 2.0 client (client credentials, PKCE with loopback
  redirect, device grant) with a token cache, and subscriptions through the official CLIs.
- `auth login`, `auth login claude`, `auth login chatgpt`, `auth status`, `auth logout`.
- Windows support for the vendor CLIs installed as `.cmd` shims, started through `cmd.exe` with
  strict quoting instead of a shell string.
