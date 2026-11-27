# Security

## Reporting

Please report a vulnerability privately through the GitHub security advisory form of this
repository (Security, Report a vulnerability). Do not open a public issue. You can expect a first
answer within a week. Supported version is the latest 0.x release.

## What tokenshrink holds

- The store (`~/.tokenshrink/tokenshrink.db` by default) keeps every original that was
  compressed with a store, which is raw tool output and can contain secrets or personal data.
  The data dir is created with mode 0700 and the file set to 0600 where the OS supports it.
  `tokenshrink forget <handle>` and `tokenshrink prune --days N` delete data.
- The store has no column for request headers, URLs or credentials, so the proxy cannot record
  them there.
- The OAuth token cache (`tokens.json` in the per user config dir) holds access and refresh
  tokens with mode 0600. `tokenshrink auth logout` removes the entry. Tokens are never printed.
- Sign ins of the official `claude` and `codex` CLIs are managed by those CLIs. tokenshrink does
  not read or reuse them.

## Threat model summary

| Boundary | Main threats | Controls |
|---|---|---|
| Proxy listener | another site reaching the proxy through the browser, DNS rebinding | binds 127.0.0.1, rejects non loopback Host, rejects Origin unless allowed |
| Proxy to upstream | leaking the client's key, redirecting traffic | auth header forwarded untouched and never stored or logged, upstream fixed by the operator |
| Proxy input | huge bodies | body limit with 413, upstream timeout |
| Store at rest | disclosure of stored tool output | file modes, forget and prune, documented retention |
| expand and MCP | crafted handles, oversized results, prompt injection in expanded text | strict handle grammar, parameterised SQL, paginated output labelled as data, no tool executes anything |
| Eval | a cases file reading arbitrary local files and sending them to a provider, prompt injection | `context_file` confined to the cases folder, the claude CLI runs without tools or MCP servers, the codex CLI with a read-only sandbox, both in an empty temp dir |
| OAuth | code interception, forged callbacks, token leaks | PKCE S256, random state checked, loopback redirect, token cache 0600, errors redact token values |

The full STRIDE table is in DEVELOPER.md.
