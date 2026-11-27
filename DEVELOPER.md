# tokenshrink developer notes

This file holds the paper phase that was written before the code, the architecture, the module
map, how to test, what was verified and what is still open.

Risk level 2 (product with external users). tokenshrink is published as open source, it sits on
the path of model requests including the auth header, and its store keeps tool outputs that can
contain secrets or personal data. Level 2 means the full work order, a threat model and the
full checklist.

## 1. Paper phase

### 1.1 One paragraph

tokenshrink takes bulky text that an AI agent is about to send to a model (logs, JSON, HTML,
CSV, stack traces, diffs, plain text), detects its type and rewrites it with one deterministic
compressor per type. Every original is stored in a local content addressed SQLite file, and
the compressed text carries short handles such as `[ts:ab12cd34 lines 120-480 omitted]` that
return the exact original span on `expand`. The same core is reachable as a library, a CLI, a
local HTTP proxy in front of an OpenAI compatible chat completions endpoint and an MCP stdio
server. An eval harness runs a model on the original and on the compressed context and reports
tokens saved and answer accuracy with pass^k.

### 1.2 IPO sheet

| Input | Source | Trust |
|---|---|---|
| Text to compress | file, stdin, library caller, proxied chat request, MCP call | untrusted data |
| Handle to expand | CLI argument, MCP call (model output) | untrusted, parsed with a strict grammar |
| Chat completions request | local client through the proxy | untrusted body, auth header passed through |
| Upstream response | model provider | untrusted, passed through byte for byte |
| Eval cases file | local file | semi trusted, `context_file` confined to its folder |
| Model answers in eval | provider | untrusted, schema validated |
| OAuth token responses | token server | untrusted, schema validated |
| Config and env | operator | trusted |

| Process | Output | Side effect |
|---|---|---|
| detect, compress (pure, deterministic) | compressed text, report | original and derived blobs written to the store |
| expand | exact original span | none |
| proxy | upstream answer unchanged | compressed request forwarded, blobs stored |
| eval | report table or JSON | model calls (cost) |
| auth login | token cached | token file in the user config dir |

### 1.3 Context diagram with trust boundaries

```
                 trust boundary A (local process input)
   +---------+        |
   | agent / |--text--+-->+----------------------------------+
   | user    |<-------+---| tokenshrink core                 |
   +---------+  compressed| detect -> compressor -> handles  |
                      |   +-----+-----------------+----------+
   +---------+        |         |                 |
   | MCP host|--json-rpc stdio->| expand          | put/get
   +---------+        |         v                 v
                      |   +-----------+     +-------------------+
   +---------+  HTTP  |   | proxy     |     | store (node:sqlite)|  trust boundary C
   | client  |--127.0.0.1-->| compress |     | data dir, 0600     |  (disk at rest)
   +---------+  auth  |   +-----+-----+     +-------------------+
                      |         | auth header untouched
   - - - - - - - - - -+- - - - -|- - - - - - - - - - - - - - - trust boundary B (network)
                                v
                   +--------------------------+     +-----------------------+
                   | upstream chat endpoint   |     | OAuth token server    |
                   +--------------------------+     +-----------------------+
                   +--------------------------+
                   | eval provider: openai,   |  claude / codex CLI run as a
                   | anthropic, claude-cli,   |  subprocess (trust boundary D)
                   | codex-cli                |
                   +--------------------------+
```

### 1.4 Data model

`blobs` keeps every original and every derived text (for example the readable text extracted
from HTML). `runs` keeps one row per compression for `stats`. There is no column for headers,
URLs or credentials, so the store cannot record them by construction.

| Table | Column | Constraint |
|---|---|---|
| blobs | hash | TEXT PRIMARY KEY, 64 hex chars (sha256 of the UTF-8 text) |
| blobs | created_at | TEXT NOT NULL, ISO 8601 UTC |
| blobs | type | TEXT NOT NULL, one of the detector types |
| blobs | parent | TEXT NULL, FK blobs(hash) ON DELETE CASCADE (derived blobs) |
| blobs | chars, lines | INTEGER NOT NULL, CHECK >= 0 |
| blobs | content | BLOB NOT NULL, raw deflate of the UTF-8 text |
| runs | id | INTEGER PRIMARY KEY |
| runs | created_at, hash, source, type, level | NOT NULL, source CHECK in a closed set, FK hash |
| runs | original_tokens, compressed_tokens | INTEGER NOT NULL |

Who reads and writes. Only the local user who owns the data dir. The proxy, the CLI and the MCP
server run as that user. The data dir is created 0700 and the file is set to 0600 where the OS
supports it. Schema version lives in `PRAGMA user_version`.

The token cache is a separate JSON file in the per user config dir (0600), keyed by token URL,
client id and scope. It never enters the SQLite store.

### 1.5 Quality attribute scenarios

1. Losslessness. Source is any compressor. Stimulus is an `expand` of any handle that appears in
   the output. Response is the exact substring of the original. Measure is 100 percent of
   handles in the test corpus, checked by a reconstruction test that rebuilds the original
   lines from the kept lines plus the expanded markers.
2. Determinism. Same input and options on Windows, macOS and Linux give byte identical output.
   Measure is the CI matrix running the same snapshot style assertions on three OSes.
3. Proxy transparency. A streaming request through the proxy returns the upstream bytes
   unchanged and adds under 50 ms for a 1 MB request on a laptop. Measure is the proxy test
   comparing bytes, and the bench timing for compression.

Deliberately not optimised. Compression ratio on prose (plain text gets only whitespace and
repeat folding plus head and tail truncation), and model aware tokenisation.

### 1.6 Decisions likely to change and the module that hides each

| Decision | Hidden in |
|---|---|
| Handle syntax and span addressing | `src/handles.js` |
| Storage engine, schema, at rest encoding | `src/store.js` |
| Token estimation method | `src/tokens.js` |
| Detection heuristics and their order | `src/detect.js` |
| Per type compression rules and level tables | `src/compressors/*.js` |
| Budget escalation strategy | `src/compress.js` |
| Model provider, wire format, auth | `src/provider/*.js`, `src/auth/*.js` |
| Eval prompt | `prompts/eval-answer.v1.md` |
| Proxy routing and header policy | `src/proxy.js` |
| MCP protocol version | `src/mcp.js` |

### 1.7 Back of the envelope

Numbers computed with a short node script (kept below), not by hand.

```
turns=30, tool=6000 tokens per tool output, base=3000 tokens, ratio=0.2 compressed/original
input tokens over the run = sum over t of (base + t*tool)   -> 2 880 000 raw
same with compressed tool outputs                           ->   648 000 (77.5 percent less)
at an example price of 3 USD per million input tokens       -> 8.64 USD vs 1.94 USD per run
```

The ratio 0.2 is an assumption for the estimate. The measured ratios per type are in the README
table. Prompt caching lowers both numbers, the saving ratio stays similar because compressed
text is also cacheable.

LLM cost of tokenshrink itself. Compression calls no model. The only model calls are in
`tokenshrink eval`. A typical eval smoke run with 2 cases, 2 variants and k=2 is about
2*2*(1500+200) + 2*2*(400+200) = 9 200 input tokens and 2*2*2*60 = 480 output tokens.

Store growth. 1 000 tool outputs a day at 24 KB average with deflate at about 0.15 gives about
3.6 MB a day, about 108 MB in 30 days. `tokenshrink prune --days N` bounds it.

CPU. Every compressor is linear in input size apart from sorting distinct values for stats.
The bench script prints the measured time per file.

### 1.8 Five minute threat model (STRIDE on the boundaries)

What are we building, what can go wrong, what do we do, did we do a good job.

| Boundary | Threat | Mitigation |
|---|---|---|
| B proxy listener | Spoofing by another local site through DNS rebinding | Bind 127.0.0.1 by default, reject a Host header that is not loopback, reject requests with an Origin header unless allowed |
| B proxy | Information disclosure of the client's key | Auth header forwarded untouched, never logged, never stored, the store has no column for it, test asserts the DB bytes do not contain it |
| B proxy | Tampering with the upstream target (SSRF) | Upstream host is fixed by the operator, the request path is appended to it, the Host is never taken from the client |
| B proxy | Denial of service by huge bodies | Body limit (default 32 MB, 413 above it), upstream timeout |
| C store | Information disclosure of stored tool outputs | Data dir 0700, file 0600, `forget` and `prune`, documented in SECURITY.md |
| A expand / MCP | Tampering through a crafted handle | Strict grammar, hex prefix only, parameterised SQL, range checks, size limited and paginated MCP output |
| A MCP | Prompt injection inside expanded content | Output marked as original tool output and data, no tool executes anything |
| D eval | Elevation through prompt injection in eval context | claude-cli runs with no tools, no MCP servers, dontAsk mode, in an empty temp dir; codex-cli runs with a read-only sandbox in an empty temp dir; answers are only scored |
| D eval | Information disclosure by a cases file reading arbitrary files | `context_file` must resolve inside the cases file folder |
| B OAuth | Spoofing of the redirect (code interception) | PKCE S256, random state checked, loopback on 127.0.0.1 with a random port, single use listener |
| B OAuth | Disclosure of tokens | Token cache 0600, never printed by `auth status`, never logged, errors redact token values |
| B provider | Repudiation, unclear cost | Every eval call records model, tokens and latency in the report |

### 1.9 Decision tables

Proxy, what happens to one content part of one message.

| Condition | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Path ends with /chat/completions and body is JSON | N | Y | Y | Y | Y |
| Message role is in the configured roles | . | N | Y | Y | Y |
| Part is text (string content or text part) | . | . | N | Y | Y |
| Estimated tokens above threshold | . | . | . | N | Y |
| Action | forward body untouched | keep | keep | keep | compress, store, replace |

Budget mode, what `compress` returns.

| Condition | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Budget given | N | N | Y | Y | Y |
| Original fits (budget, or compressed not smaller) | Y | N | Y | N | N |
| Some level up to 4 fits | . | . | . | Y | N |
| Head and tail skeleton fits | . | . | . | . | Y or N |
| Result | original, compressed=false | compressed at the requested level | original | that level | skeleton, or fits=false and exit code 3 |

Auth selection for a model call.

| Condition | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| Adapter is claude-cli or codex-cli | Y | N | N | N |
| Auth is oauth | . | Y | N | N |
| API key env present | . | . | Y | N |
| Result | subprocess, CLI handles its own login | bearer from token cache, refresh or login hint | api key header | openai adapter without key (local servers), anthropic fails closed |

## 2. Architecture

One small ESM package with one core and four thin interfaces (library, CLI, proxy, MCP). No runtime or dev dependencies. Node 22.5 or newer.

```
bin/tokenshrink.js        CLI, argument parsing, re-spawn with --experimental-sqlite on old 22.x
src/index.js              library API
src/compress.js           orchestration, header, budget escalation, skeleton fallback
src/detect.js             content type detector
src/tokens.js             token estimator
src/handles.js            handle format and parsing, span slicing
src/plan.js               shared line plan renderer (kept lines, omitted runs, markers)
src/compressors/*.js      json, log, stacktrace, html, csv, diff, text
src/store.js              node:sqlite store
src/proxy.js              HTTP proxy
src/mcp.js                MCP stdio server
src/eval.js               eval harness
src/config.js             config file, env and flag merge
src/provider/*.js         adapters openai, anthropic, claude-cli, codex-cli, fake, http helper
src/auth/*.js             oauth client, token cache, config dir, browser opener
prompts/eval-answer.v1.md eval prompt, versioned
```

Import graph has no cycles. The compressors import only `plan.js` and `tokens.js`. Interfaces
import `compress.js` and `store.js`, never each other.

Architecture decisions are in `docs/adr/`.

## 3. How to test

```
npm test                       # 71 tests, node:test, no network, fake provider, local sockets only
node --experimental-sqlite --test   # the same on Node 22.5 to 22.12
node scripts/bench.js          # README token table
node scripts/make-examples.js  # regenerates examples/ deterministically
```

What the tests cover. Detection of every type including CRLF and edge inputs. A rebuild test
for log, both stack traces, diff and CSV at every level 0 to 4, which replaces each marker with
its expansion and compares with the original lines. JSON validity, exact omitted items and
statistics checked against values computed from the source. HTML extraction and derived blobs.
Determinism. Budget escalation, skeleton fallback and the cannot fit case. Store round trip,
dedupe, prefix ambiguity, range checks, forget, prune, file modes. Proxy compression, auth
header pass through, a scan of the store files for the key, SSE streaming, pass through of other
paths and non JSON bodies, Host, Origin and size checks, upstream down. MCP over stdio and tool
errors. HTTP retry, timeout and redaction. OpenAI and Anthropic adapters against a fake fetch.
Claude and codex CLI arguments, output parsing and the adapters with a fake spawn. Subscription
login flow with a fake spawn. OAuth against a local fake token server, PKCE against the RFC 7636
example, client credentials with post and basic auth, refresh before expiry, failed refresh,
PKCE loopback with state check and denial, device polling with authorization_pending and
slow_down. Eval loading, path confinement, schema check, pass^k and fail closed. CLI exit codes
and every command.

MCP protocol versions. The server answers `initialize` with the client's version when it is one
of 2025-11-25, 2025-06-18, 2025-03-26 or 2024-11-05, otherwise with 2025-11-25. `tools/list`
and `tools/call` also work without `initialize`.

## 4. Desk check

### Trace table, `sliceSpan` (the function every expand goes through)

| text | span | lineStarts | countLines | endsWithNewline | from | to | result |
|---|---|---|---|---|---|---|---|
| `a\nb\nc\n` | lines 2-3 | 0,2,4,6 | 3 | yes (3 < 4) | 2 | 6-1=5 | `b\nc` |
| `a\r\nb\r\n` | lines 1-1 | 0,3,6 | 2 | yes | 0 | 3-1=2, minus the \r = 1 | `a` |
| `x` (boundary, no final newline) | lines 1-1 | 0 | 1 | no (1 = 1) | 0 | 1 | `x` |
| `a\n\nb` (empty line) | lines 2-2 | 0,2,3 | 3 | yes | 2 | 2 | empty string |
| `a\nb` | lines 1-3 | 0,2 | 2 | . | . | . | BAD_RANGE, original has 2 lines |

Each row was also run in code on 2026-11-27 and gave the result in the last column.

### Trace table, `renderPlan` run detection with minOmit 2 on lines A B C D

| keep | i steps | runs found | output |
|---|---|---|---|
| 1 0 0 1 | 0 keep, 1 run to 2, 3 keep | 2-3 (length 2) | `A`, marker lines 2-3, `D` |
| 0 1 0 0 | 0 run of length 1 shown, 1 keep, 2 run to 3 | 3-4 | `A`, `B`, marker lines 3-4 |
| 1 1 1 1 | all keep | none | `A B C D` |
| 0 0 0 0 (boundary) | 0 run to 3 | 1-4 | one marker lines 1-4 |

Also run in code with the same results.

### Reader pass

compress() hashes the text, runs the compressor at the start level, and in budget mode raises
the level while the estimate is above the budget. If nothing fits it binary searches the number
of head and tail lines of the compressed body that still fit, against a derived blob of that
body. Without a budget a result that is not smaller than the input is dropped and the input is
returned. Only blobs referenced by the output are stored. This matches the intent. One subtle
point found in the reader pass and kept on purpose. In the skeleton search every probe marks the
derived blob as used, so the derived body is stored even in the rare case where the final
skeleton kept every line. That costs one extra blob and no correctness.

The proxy reads the whole body (bounded), rewrites only text parts of messages in the allowed
roles above the threshold, and forwards with the original headers minus hop by hop headers. The
response is piped. This matches the decision table in 1.9.

### Checklist (canon section 4), level 2

| Item | State |
|---|---|
| Can be told in one paragraph | yes, 1.1 |
| External services behind one module each | yes, provider/*, auth/*, store.js |
| Import graph without cycles, no utils dump | yes, checked by reading the imports |
| Non trivial decisions written down | ADR 0001 to 0007 |
| Schema with constraints | STRICT tables, CHECK on hash length, type, source, counts, FK with cascade |
| Time in UTC | ISO 8601 UTC strings |
| Secrets not in repo, logs or prompts | checked with a grep for key patterns, the store has no header column, tests scan the DB for the key |
| All external input validated | handles by grammar, MCP arguments, cases file, token responses, eval answers, config file |
| Parameterised SQL, no shell strings | yes, prepared statements, spawn with arrays and shell false |
| Dependencies | none |
| GitHub Actions pinned to SHA, minimal permissions | yes, checkout v7.0.1 and setup-node v7.1.0 SHAs checked with the GitHub API and git ls-remote, contents read |
| Fail closed, no stack trace to the user | CLI prints one line errors, MCP returns structured tool errors |
| LLM call timeout, token limit, validated output | timeout per call, max_tokens 300 in eval, schema check with one repair |
| Model id logged | eval report lists the models the provider reported |
| Prompt in a versioned file | prompts/eval-answer.v1.md, version in every report |
| Eval set and threshold | examples/cases.jsonl, `--gate` compares compressed pass^k with original pass^k |
| pass^k with k stated | yes |
| Lethal trifecta | eval reads untrusted context and sends it to a provider, but the model has no tools, so there is no exfiltration path beyond the answer text |
| Rate limit, cost cap | not applicable to compression. Eval has no cost cap of its own, see gaps |
| Backup and restore | not applicable, the store is a local cache of the user's own data |

## 5. Verified

- 2026-11-27, `node --test` on macOS, Node 24.22.1. 69 tests, 69 pass.
- 2026-11-27, after the first CI run. 71 tests, 71 pass on macOS with Node 24.22.1, Node 22.23.5
  (`node --test`) and Node 22.5.1 (`node --experimental-sqlite --test`). The CLI on Node 22.5.1
  compressed a file and printed stats without the flag, through its own re-run.
- 2026-11-27, `node scripts/bench.js` on macOS, Node 24.22.1. Output is the README table.
- 2026-11-27 14:03 UTC, real smoke test with the claude-cli adapter. Command
  `TOKENSHRINK_CONFIG_DIR=<temp> node bin/tokenshrink.js eval examples/cases.jsonl --provider claude-cli --k 2`.
  Eight model calls. The CLI reported the model `claude-fable-5-2`. The result follows.

  | case | type | est. tokens original | est. tokens compressed | measured input original | measured input compressed | pass original | pass compressed |
  |---|---|---:|---:|---:|---:|---:|---:|
  | log-failed-order | log | 3111 | 1513 | 16006 | 14097 | 2/2 | 2/2 |
  | json-user-count | json | 3299 | 667 | 15962 | 13004 | 2/2 | 2/2 |

  Estimated context tokens 6410 to 2180 (66 percent saved). Provider measured input 31968 to
  27101 per run summed over the cases (4867 fewer, 15.2 percent). Both variants pass@1 100
  percent and pass^2 100 percent, no invalid replies, no errors. Reported cost 1.0069 USD for the
  eight calls, as reported by the CLI. Whether that amount is billed depends on the account. The measured
  difference per case was 1.12 to 1.20 times the estimated difference, so the estimator counts
  low by about 12 to 20 percent on this text. About 12 000 input tokens per call are fixed
  overhead of the claude CLI.

- 2026-11-27, `tokenshrink auth status` on this machine with the real `claude` and `codex` CLIs
  reported both as signed in, without printing any account data or token. The proxy command was
  started from the CLI, answered 502 with the JSON error for an unreachable upstream, and logged
  one line without content or headers.

### First CI run, what failed and what changed

- Node 22 on every OS. `requestJson` used `AbortSignal.timeout()`, whose timer is unref'd. On
  Node 22 the timeout test left the event loop empty, the runner cancelled the rest of the
  provider tests (`cancelledByParent`). The HTTP helper now uses an AbortController with a normal
  timer that is cleared after the call.
- Windows. The proxy test removed its temp dir while the SQLite file was still open (`EBUSY`).
  Tests now close every store and server before cleanup, cleanup retries, and a leftover dir is
  reported as a diagnostic instead of failing the run. Tests that spawn processes or open sockets
  have a timeout, the runner has `--test-timeout`, and each CI job has `timeout-minutes`.
- Windows product code. Vendor CLIs installed as `.cmd` shims are resolved with PATHEXT and
  started through cmd.exe with strict quoting (ADR 0007). The claude system prompt moved from an
  argument to `--system-prompt-file`.
- CI actions moved to checkout v7.0.1 and setup-node v7.1.0 (Node 24 runtime), pinned by the
  commit SHA from the GitHub API. A job on Node 22.5.1 checks the minimum version.

## 6. Known gaps and what was not verified

- No Windows or Linux machine ran the code locally. CI covers both, its result after the fixes
  below is for the owner to check. Windows specific paths (`%APPDATA%`, `rundll32` browser open,
  `.cmd` shim quoting through cmd.exe, `taskkill` on timeout, file modes) are unit tested where
  possible but were not run against a real Windows install of the vendor CLIs.
- The claude CLI adapter now passes the system prompt with `--system-prompt-file`. The flag was
  checked to exist (the CLI rejects a missing file before any model call), but no model call ran
  with it after the smoke test, which used the older `--system-prompt` argument.
- The real `codex-cli` adapter was not called. Only its argument list and its event parser are
  tested against made up output, the event format of the real CLI is assumed.
- `auth login claude` and `auth login chatgpt` were tested with a fake spawn only. The real
  interactive sign in was not run, because this machine is already signed in.
- The OAuth client was tested only against the local fake server. No real identity provider
  (Entra ID, other gateways) was tried. The browser opener was not run.
- The `openai` and `anthropic` adapters were tested only against a fake fetch. No real endpoint
  was called.
- The proxy was tested with a local fake upstream, not with a real provider or a real agent.
- The token estimator is not calibrated per tokenizer. The single data point is the smoke run.
- Eval has no cost ceiling of its own. The smoke run cost 1.01 USD for eight tiny calls through
  the claude CLI, so large case files can be expensive.
- Input that is not valid UTF-8 does not round trip byte for byte.
- A short id can become ambiguous when a later blob shares its prefix. Expand then fails closed.
- Detection is heuristic. A log with a perfectly regular comma count and a header like first line
  can be taken for CSV, which is still lossless but less useful.
