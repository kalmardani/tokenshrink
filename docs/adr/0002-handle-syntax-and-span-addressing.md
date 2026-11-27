# ADR 0002. Handle syntax and span addressing

## Status
Accepted, 2026-11-27

## Context
The compressed text must say where something was left out and how to get it back, in a form a
model copies reliably and a parser can check strictly.

## Decision
Markers look like `[ts:ab12cd34 lines 120-480 omitted, summary]` or
`[ts:ab12cd34 chars 1201-9876 omitted, summary]`. The id is the shortest prefix of the sha256,
at least 8 hex characters, that is unique in the store when the marker is written. Line spans are
1 based and inclusive and split on `\n`, so CRLF and LF input have the same line numbers. Char
spans are 1 based, inclusive, in UTF-16 code units. A span excludes the terminator of its last
line.

Expand accepts the marker text, `ts:<id>`, `ts:<id>:A-B` and `ts:<id>:cA-B`. An id that matches
more than one blob fails closed.

## Consequences
- Line based compressors can be checked by a rebuild test, kept lines plus expanded markers equal
  the original lines.
- 8 hex characters cost about two tokens more than 6 and make collisions very unlikely. A later
  blob can still make an old short id ambiguous. Expand then refuses instead of guessing.
- Character offsets in UTF-16 are natural in JavaScript and unusual elsewhere. Other
  implementations must follow the same unit.
