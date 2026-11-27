# tokenshrink

Context compression for AI agents that never loses data.

Agents spend most of their tokens on bulky tool output such as logs, JSON responses, HTML pages,
CSV exports, stack traces and diffs. tokenshrink detects what kind of text it is looking at and
shrinks it with plain, deterministic code before it reaches the model. Every original is kept in
a local store, and the compressed text carries short handles like
`[ts:1f4b5554 lines 124-132 omitted, 9 library frames]`. Expanding a handle returns the exact
original span, so the model, the agent or you can always get the full data back.

It has no dependencies. It needs Node.js 22.5 or newer and runs on Windows, macOS and Linux.

## Quick start

Without installing anything, run it straight from GitHub.

```
npx github:kalmardani/tokenshrink compress build.log
npx github:kalmardani/tokenshrink expand ts:ab12cd34:120-480
```

Or work from a local clone.

```
git clone https://github.com/kalmardani/tokenshrink
cd tokenshrink
node bin/tokenshrink.js compress examples/app.log
node --test
```

## What it does to each type

| Type | What is kept | What becomes a handle |
|---|---|---|
| JSON | the full shape, a few samples of each long array, per field statistics for the whole array | the omitted array items, long strings, extra keys of very wide objects |
| Log | the first line of every distinct template (timestamps, ids and numbers normalised), every distinct error and warning with context, head and tail | runs of repeated or near repeated lines, with counts of the most common templates |
| Stack trace | exception messages, application frames, the first frame of each trace | runs of library and runtime frames (named by package), deep recursion |
| HTML | readable text with headings, list items, table rows and link targets | the markup itself (the header handle), and at higher levels long parts of the extracted text |
| CSV, TSV | the header, the first and last rows, per column statistics over all rows | the rows in between |
| Unified diff | file headers, hunk headers, every changed line, a small context window | trimmed context lines, lock file bodies, the rest of very large hunks |
| Plain text | everything at level 0, head and tail of long texts from level 1 | repeated lines, the middle of long texts, very long lines |

Levels go from 0 (gentle) to 4 (hardest), the default is 1.

## Measured on the example files

Produced by `node scripts/bench.js`, which runs the CLI on every file in `examples/`. Token
numbers come from the built in estimator, bytes are exact. Wall time includes Node start up.

tokenshrink 0.1.0, node 24.22.1, darwin, default level 1

| file | type | bytes in | bytes out | tokens in (est.) | tokens out (est.) | saved % | wall ms |
|---|---|---:|---:|---:|---:|---:|---:|
| app.log | log | 283835 | 7243 | 149239 | 3463 | 97.7 | 175 |
| users.json | json | 339620 | 1773 | 128471 | 706 | 99.5 | 178 |
| orders.csv | csv | 111259 | 1011 | 56907 | 425 | 99.3 | 146 |
| node-trace.txt | stacktrace | 6358 | 506 | 2827 | 183 | 93.5 | 115 |
| java-trace.txt | stacktrace | 5983 | 945 | 1840 | 293 | 84.1 | 113 |
| page.html | html | 25317 | 4752 | 14704 | 1594 | 89.2 | 124 |
| change.diff | diff | 19093 | 3519 | 9816 | 1521 | 84.5 | 124 |
| notes.txt | text | 13652 | 13652 | 3104 | 3104 | 0 | 114 |
| total | | | | 366908 | 11289 | 96.9 | |

The example files are generated from a fixed seed by `scripts/make-examples.js`. They are
repetitive on purpose, like real machine output, so real files will usually save less. The
plain text file is not compressed at level 1 because it is short enough, which is the intended
behaviour.

A real eval run with the claude CLI on the two tiny cases in `examples/cases.jsonl`, k=2, on
2026-11-27, gave the same accuracy for the original and the compressed context (pass^2 100
percent for both) with 66 percent fewer estimated context tokens. The provider reported 4 867
fewer input tokens over the two cases. Details are in DEVELOPER.md under Verified.

## Example output

```
$ tokenshrink compress examples/node-trace.txt
[tokenshrink ts:1f4b5554 stacktrace 2827 to 183 tokens est., expand a ts: handle to restore any omitted part]
RangeError: Maximum call stack size exceeded
    at walk (/srv/app/src/tree/walk.js:12:10)
    at walk (/srv/app/src/tree/walk.js:18:12)
    at walk (/srv/app/src/tree/walk.js:18:12)
[ts:1f4b5554 lines 5-122 omitted, 118 frames, 118 repeat the frame above]
    at buildIndex (/srv/app/src/tree/index.js:44:3)
[ts:1f4b5554 lines 124-132 omitted, 9 library frames; express 7, body-parser 1, node 1]

$ tokenshrink expand ts:1f4b5554:124-126
    at /srv/app/node_modules/express/lib/router/layer.js:95:5
    at next (/srv/app/node_modules/express/lib/router/route.js:149:13)
    at Route.dispatch (/srv/app/node_modules/express/lib/router/route.js:119:3)
```

```
$ tokenshrink compress examples/orders.csv --level 2
[tokenshrink ts:ac762de7 csv 56907 to 347 tokens est., expand a ts: handle to restore any omitted part]
order_id,date,customer,country,status,amount,currency,note
ord_10001,2026-10-15,cust_318,PL,shipped,2306.00,EUR,
ord_10002,2026-06-13,cust_720,SK,returned,2098.49,EUR,
ord_10003,2026-07-08,cust_684,RO,shipped,195.83,EUR,
[ts:ac762de7 lines 5-2000 omitted, 1996 rows]
ord_12000,2026-05-13,cust_176,RO,returned,939.94,EUR,
[stats 2000 rows x 8 columns]
order_id text unique, len 9-9
date date 2026-01-01..2026-10-28
customer text 739 distinct, len 6-8, top 'cust_388' 8 'cust_474' 8 'cust_136' 7
country text 6 distinct, len 2-2, top 'SK' 344 'HU' 343 'PL' 343
status text 4 distinct, len 7-9, top 'shipped' 1017 'cancelled' 343 'returned' 334
amount number 5.1..2498.39 mean 1283.6
currency text 'EUR' 2000
note text 'gift wrap, deliver af...' 109, 1891 empty
```

## Three interfaces on one core

### Command line

```
tokenshrink compress <file|->      compress a file or stdin
  --type T  --level N  --budget N  --no-header  --json  --verbose  --no-store  --data-dir DIR
tokenshrink expand <handle>        exact original behind a handle or marker
tokenshrink detect <file|->        detected type and the reason
tokenshrink stats [--json]         stored originals and tokens saved
tokenshrink forget <handle>        delete one original and what was derived from it
tokenshrink prune --days N         delete originals older than N days
tokenshrink proxy --upstream URL   local proxy for chat completions
tokenshrink mcp                    MCP server on stdio
tokenshrink eval <cases.jsonl>     compare answers on original and compressed context
tokenshrink auth login|status|logout
```

`--budget 2000` compresses harder, level by level, until the estimate fits. If the hardest level
is still too large it keeps the head and tail of the compressed text and marks the middle. If
even that cannot fit, it says so and exits with code 3. Other exit codes are 0 for success, 1
for runtime errors, 2 for usage errors and 4 for a failed eval gate.

A handle can be given as the full marker text, as `ts:ab12cd34` for the whole original, as
`ts:ab12cd34:120-480` for lines or as `ts:ab12cd34:c1200-5800` for characters. Ranges are 1
based and inclusive.

### Library

```js
import { compress, expand, openStore } from 'tokenshrink';

const store = openStore();                       // or openStore({ dir }) or openStore({ memory: true })
const r = compress(toolOutput, { store, budget: 2000 });
// r.text, r.type, r.originalTokens, r.tokens, r.level, r.fits, r.handle
const original = expand(r.handle, { store });    // exact original
store.close();
```

`compress` is synchronous and deterministic. Without a store it still compresses, but the
markers carry no handle.

### Local HTTP proxy

```
tokenshrink proxy --upstream https://api.openai.com --threshold 1000
```

Point any OpenAI compatible client at `http://127.0.0.1:8787/v1`. For `POST .../chat/completions`
the proxy compresses every text content of `tool`, `function` and `user` messages above the
threshold (estimated tokens), stores the originals, and forwards the request. Everything else,
including the streamed or plain answer, passes through byte for byte. The client's
`Authorization` header is forwarded untouched and never stored or logged. The upstream can carry
a path prefix, for example `--upstream http://localhost:11434` for a local server or
`--upstream https://example-gateway.internal/openai`.

The proxy binds 127.0.0.1 by default, rejects requests whose Host is not a loopback name, and
rejects browser requests unless `--allow-origin` names the origin. It does not retry, so the
client's own retry policy stays in charge. If a body cannot be compressed it is forwarded
unchanged.

### MCP server

```
tokenshrink mcp
```

A stdio server (JSON-RPC 2.0, one message per line) with three tools. `expand` returns the
original behind a handle, paginated with `offset` and `max_chars`. `compress` compresses a text
and stores it. `stats` reports the store. Configure it in an MCP host as the command
`npx` with the arguments `github:kalmardani/tokenshrink mcp`, or `node /path/to/bin/tokenshrink.js mcp`.
Use the same data dir for the proxy and the MCP server so handles resolve.

## Eval

```
tokenshrink eval examples/cases.jsonl --provider claude-cli --k 3
```

Each line of the cases file is a JSON object with `id`, `question`, `expected` (a string or a
list of strings that must all appear in the answer), optional `match` (`contains` or `exact`) and
either `context` or `context_file` (relative to the cases file and confined to its folder). For
each case the model answers on the original and on the compressed context, k times each. The
report shows estimated and provider reported tokens, pass@1 as the mean pass rate and pass^k as
the share of cases where all k runs passed. `--gate` exits with 4 when compressed pass^k is
below original pass^k. Answers are scored in code, the model reply must be `{"answer": "..."}`
and an invalid reply gets one repair attempt before it counts as a failure.

## Connecting a model

The eval harness is the only part that calls a model. The provider and the auth are chosen
separately.

| Provider | What it talks to | Auth |
|---|---|---|
| `openai` | any OpenAI compatible chat completions endpoint, hosted or local | `api-key`, `oauth` or `none` |
| `anthropic` | the Messages API | `api-key`, or `oauth` for gateways that accept bearer tokens |
| `claude-cli` | the official `claude` CLI, `claude -p --output-format json` | `subscription` |
| `codex-cli` | the official `codex` CLI, `codex exec` | `subscription` |
| `fake` | scripted replies for tests | `none` |

### Use your own subscription

```
tokenshrink auth login claude      # then --provider claude-cli
tokenshrink auth login chatgpt     # then --provider codex-cli
```

Each command checks that the official CLI is installed, checks whether it is already signed in,
and if not starts that CLI's own interactive sign in in your terminal. tokenshrink only runs
these CLIs as subprocesses and never reads, copies or reuses the tokens they store, nor calls a
vendor API with them.

### API key

Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, or name another env var with
`TOKENSHRINK_API_KEY_ENV`.

### OAuth 2.0

For endpoints that accept bearer tokens, for example an enterprise gateway or a model endpoint
behind an identity provider. Three grants are supported.

| Grant | Use it for | Needs |
|---|---|---|
| `client_credentials` | service to service, no user | token URL, client id, client secret from env, scope |
| `pkce` | a person signs in with a browser, the redirect goes to 127.0.0.1 on a random port | auth URL, token URL, client id, scope |
| `device` | a person signs in on another device with a code | device URL, token URL, client id, scope |

```
tokenshrink auth login            # runs the configured grant, --grant overrides, --no-browser prints the URL
tokenshrink auth status           # every connection type, ready or not, never a secret
tokenshrink auth logout
```

Tokens are cached in the per user config dir with mode 0600 where the OS supports it and are
refreshed before they expire. Client credentials tokens are fetched again automatically. The
interactive grants run only on `auth login`.

### Configuration

Precedence is command line flag, env var, config file, default. The config file is
`config.json` in the per user config dir (`%APPDATA%\tokenshrink` on Windows,
`~/Library/Application Support/tokenshrink` on macOS, `$XDG_CONFIG_HOME/tokenshrink` or
`~/.config/tokenshrink` on Linux), or the file named by `--config` or `TOKENSHRINK_CONFIG`.
Secrets are read from env vars only, a config file that contains one is rejected.

```json
{
  "provider": "openai",
  "model": "your-model-id",
  "baseUrl": "https://gateway.example.com/v1",
  "auth": {
    "type": "oauth",
    "oauth": {
      "grant": "client_credentials",
      "tokenUrl": "https://login.example.com/oauth2/token",
      "clientId": "your-client-id",
      "clientSecretEnv": "GATEWAY_CLIENT_SECRET",
      "scope": "api://gateway/.default"
    }
  }
}
```

| Env var | Meaning |
|---|---|
| `TOKENSHRINK_DIR` | data dir of the store, default `~/.tokenshrink` |
| `TOKENSHRINK_UPSTREAM` | default upstream for `proxy` |
| `TOKENSHRINK_PROVIDER` | `openai`, `anthropic`, `claude-cli`, `codex-cli`, `fake` (default `claude-cli`) |
| `TOKENSHRINK_MODEL` | model id, required for `openai` and `anthropic` |
| `TOKENSHRINK_BASE_URL` | base URL, default `https://api.openai.com/v1` or `https://api.anthropic.com` |
| `TOKENSHRINK_AUTH` | `api-key`, `oauth`, `subscription`, `none` |
| `TOKENSHRINK_API_KEY_ENV` | name of the env var that holds the key |
| `TOKENSHRINK_OAUTH_GRANT` | `client_credentials`, `pkce`, `device` |
| `TOKENSHRINK_OAUTH_TOKEN_URL`, `_AUTH_URL`, `_DEVICE_URL` | OAuth endpoints |
| `TOKENSHRINK_OAUTH_CLIENT_ID`, `_SCOPE`, `_AUDIENCE` | OAuth client settings |
| `TOKENSHRINK_OAUTH_CLIENT_SECRET` | client secret (env only) |
| `TOKENSHRINK_OAUTH_CLIENT_AUTH` | `post` (default) or `basic` |
| `TOKENSHRINK_TIMEOUT_MS` | timeout per model call, default 120000 |
| `TOKENSHRINK_TEMPERATURE` | sent only when set |
| `TOKENSHRINK_CLAUDE_BIN`, `TOKENSHRINK_CODEX_BIN` | path of the vendor CLIs if not on PATH |
| `TOKENSHRINK_CONFIG`, `TOKENSHRINK_CONFIG_DIR` | config file and config dir overrides |

## How it works

1. The detector checks the text in a fixed order (JSON, diff, stack trace, HTML, CSV, log,
   text) and returns the type with a reason.
2. The compressor for that type decides what to keep at the chosen level. Line based types mark
   every dropped run of lines with one handle, so kept lines plus expanded handles rebuild the
   original exactly. JSON keeps valid JSON and points at exact character spans.
3. In budget mode the level goes up until the estimate fits, then a head and tail skeleton is
   tried.
4. The original, and any derived text such as the text extracted from HTML, is written to the
   store only if the result references it. The store is one SQLite file keyed by sha256, with
   deflate on disk.

The token estimate is a fast heuristic over word, number and symbol runs. It is not a real
tokenizer. In the smoke run the provider counted about 12 to 20 percent more tokens for the
same text than the estimate.

## Limits

- Token counts are estimates. Use eval for provider measured numbers.
- Plain prose compresses little.
- Input is treated as UTF-8 text. Invalid bytes become U+FFFD before hashing, so a binary file
  does not round trip byte for byte.
- The store grows until you run `prune` or `forget`. It holds whatever tool output passed
  through, which can include secrets, so treat the data dir like the data itself.
- `node:sqlite` is still experimental in Node. On Node 22.5 to 22.12 the CLI re-runs itself with
  `--experimental-sqlite`, a library user has to pass that flag.
- The proxy speaks the chat completions wire format only.
- In eval, the claude CLI adds a fixed overhead of about 12 000 input tokens per call, which
  makes the measured saving look smaller than the context saving.

## Licence

MIT, see LICENSE. Copyright (c) 2026 Kalmár Dániel.
