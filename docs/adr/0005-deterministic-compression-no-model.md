# ADR 0005. Compression is deterministic code, no model in the path

## Status
Accepted, 2026-11-27

## Context
A model could summarise tool output, but it costs tokens, adds latency, can invent content and
can be steered by text inside the output.

## Decision
All compressors are plain code with fixed level tables. The only model calls are in
`tokenshrink eval`, which measures whether compression changes answers.

## Consequences
- Same input, same output on every OS. Zero cost per compression.
- Prose gains little, because only structure, repetition and length can be exploited.
- Prompt injection inside a tool output cannot change what is kept.
