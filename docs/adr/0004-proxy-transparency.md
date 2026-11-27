# ADR 0004. Proxy is transparent, does not retry, and fails open on compression errors

## Status
Accepted, 2026-11-27

## Context
The shared rules ask for bounded retries on 429 and 5xx for every external call. The proxy sits
between a client and its provider and forwards the client's own request and key.

## Decision
- The proxy does not retry. It returns the upstream status, headers and body unchanged, so the
  client's own retry policy stays in charge and no request is billed twice by the proxy.
- It has an idle timeout (default 600 s) and answers 502 or 504 with a JSON error when the
  upstream is unreachable.
- If a body is not JSON, not identity encoded, or compression throws, the original body is
  forwarded unchanged. The request still works, only without savings.
- It binds 127.0.0.1 by default, rejects non loopback Host headers and any Origin header that is
  not explicitly allowed.

## Consequences
- The retry rule of the provider layer applies to tokenshrink's own model calls (eval), not to
  traffic it relays. This is a deliberate exception the owner should confirm.
- A bug in a compressor cannot break the client's request.
