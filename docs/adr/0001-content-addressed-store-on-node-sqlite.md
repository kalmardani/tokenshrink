# ADR 0001. Content addressed store on node:sqlite

## Status
Accepted, 2026-11-27

## Context
Every compression must stay reversible, across processes (CLI, proxy, MCP server) and across
restarts. The project allows no dependencies. Originals can be large and repetitive.

## Decision
One SQLite file in the data dir, opened with the built in `node:sqlite`. Blobs are keyed by the
sha256 of their UTF-8 text and stored with raw deflate. WAL mode and a busy timeout let several
local processes share the file. A `runs` table records one row per compression for `stats`.
Schema version lives in `PRAGMA user_version`.

## Consequences
- Same content is stored once. Expansion is a primary key lookup.
- No server, no dependency, works on all three OSes.
- `node:sqlite` is still marked experimental. Node 22.5 to 22.12 need a flag, which the CLI adds
  by re-running itself. The library caller must add it on those versions.
- The store grows until `prune` or `forget` runs. There is no automatic retention.
