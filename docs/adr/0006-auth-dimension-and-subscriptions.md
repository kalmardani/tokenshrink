# ADR 0006. Auth as its own dimension, subscriptions only through the official CLIs

## Status
Accepted, 2026-11-27

## Context
Users reach models through API keys, enterprise gateways that want OAuth bearer tokens, or a
personal subscription.

## Decision
The provider config has an adapter (openai, anthropic, claude-cli, codex-cli, fake) and an auth
type (api-key, oauth, subscription, none). OAuth is a small built in client with client
credentials, authorization code with PKCE and a loopback redirect, and the device grant. Tokens
are cached in the per user config dir with mode 0600 and refreshed before expiry. A
subscription is used only by running the official `claude` or `codex` CLI as a subprocess, and
`auth login claude|chatgpt` starts their own sign in. tokenshrink never reads the tokens those
CLIs store and never calls a vendor API with them.

## Consequences
- One code path per auth type, testable against a local fake token server.
- The CLI adapters carry each vendor CLI's fixed overhead per call (the smoke run measured about
  12 000 input tokens per call for the claude CLI), which dilutes the measured savings in eval.
- Secrets are only read from env vars. A config file holding a secret is rejected.
