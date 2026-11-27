# ADR 0003. Compressed JSON stays valid JSON

## Status
Accepted, 2026-11-27

## Context
JSON could be rendered as annotated pseudo JSON with comments, which reads well, or kept valid
with markers and statistics as string values.

## Decision
The body after the header line is valid JSON. Collapsed array ranges become a marker string in
place, the array gets one `[stats ...]` string at the end, long strings keep a prefix plus a
marker, wide objects get one marker key. Samples keep their raw source text.

## Consequences
- Downstream code that parses tool output still parses it.
- Markers inside strings are slightly less obvious to a model than comments would be.
- Character spans point at the raw source, so expanding an array range gives the exact items
  text, which can be wrapped in `[` `]` and parsed.
