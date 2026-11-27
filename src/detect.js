// Content type detector. Cheap checks first, each returns a confidence. The first strong
// match wins in a fixed order so the result is deterministic.

export const TYPES = ['json', 'diff', 'stacktrace', 'html', 'csv', 'log', 'text'];

const SAMPLE_LINES = 400;

export const FRAME_RE = new RegExp(
  [
    String.raw`^\s+at\s+\S.*(?:\(.*:\d+(?::\d+)?\)|:\d+:\d+)\s*$`, // JavaScript
    String.raw`^\s+at\s+[\w$.<>/]+\(.*\)\s*$`, // Java, Kotlin, C#
    String.raw`^\s+File\s+".+",\s+line\s+\d+`, // Python
    String.raw`^\s*\S+\.go:\d+(?:\s+\+0x[0-9a-f]+)?\s*$`, // Go file line
    String.raw`^\s+\d+:\s+0x[0-9a-f]+\s+-\s+\S+`, // Rust backtrace
    String.raw`^\s+from\s+\S+:\d+:in\s+`, // Ruby
    String.raw`^#\d+\s+\S.*\(\S*:\d+\)`, // PHP
  ].join('|'),
);

const TRACE_HEAD_RE =
  /^(?:Traceback \(most recent call last\):|Exception in thread |Caused by: |goroutine \d+ \[|thread '.*' panicked at|panic: |\w+(?:\.\w+)*(?:Error|Exception)\b.*|Uncaught \w+)/;

export const TIMESTAMP_RE =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}|\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2}|^\[?\d{2}:\d{2}:\d{2}|^\d{10}(?:\.\d+)?\s/;
export const LEVEL_RE = /\b(?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|CRIT)\b/;

export function detect(text) {
  const src = String(text ?? '');
  const trimmed = src.replace(/^﻿/, '').trimStart();
  if (trimmed.length === 0) return { type: 'text', confidence: 1, reason: 'empty' };

  if ((trimmed[0] === '{' || trimmed[0] === '[') && isJson(trimmed)) {
    return { type: 'json', confidence: 1, reason: 'parses as JSON' };
  }

  const lines = sampleLines(src);
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  const total = Math.max(1, nonEmpty.length);

  // Unified diff.
  let hunks = 0;
  let fileHeads = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(l)) hunks++;
    else if (l.startsWith('diff --git ') || (l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ '))) fileHeads++;
  }
  if (hunks > 0 && (fileHeads > 0 || /^@@ /.test(trimmed))) {
    return { type: 'diff', confidence: 0.95, reason: `${hunks} hunk headers` };
  }

  // Stack trace. Frames dominate and no strong log shape around them.
  let frames = 0;
  let heads = 0;
  let stamped = 0;
  let leveled = 0;
  for (const l of nonEmpty) {
    if (FRAME_RE.test(l)) frames++;
    else if (TRACE_HEAD_RE.test(l.trim())) heads++;
    if (TIMESTAMP_RE.test(l)) stamped++;
    if (LEVEL_RE.test(l)) leveled++;
  }
  const frameShare = frames / total;
  const logShare = Math.max(stamped, leveled) / total;
  if (frames >= 3 && frameShare >= 0.4 && logShare < 0.3 && (heads > 0 || frameShare >= 0.6)) {
    return { type: 'stacktrace', confidence: 0.9, reason: `${frames} frames` };
  }

  // HTML.
  const head = trimmed.slice(0, 2000).toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || /<(?:head|body)[\s>]/.test(head)) {
    return { type: 'html', confidence: 0.95, reason: 'html document' };
  }
  const tags = (src.slice(0, 50000).match(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?>/g) ?? []).length;
  const closing = (src.slice(0, 50000).match(/<\/(?:div|p|span|a|li|td|tr|section|ul|table|h[1-6])>/gi) ?? []).length;
  if (tags >= 10 && closing >= 3 && tags / total >= 1) {
    return { type: 'html', confidence: 0.8, reason: `${tags} tags` };
  }

  // CSV or TSV. Consistent delimiter count across lines.
  const delim = csvDelimiter(nonEmpty);
  // A log with a regular comma count is still a log unless the first line looks like a header.
  if (delim && (!TIMESTAMP_RE.test(nonEmpty[0]) || logShare < 0.3)) return { type: 'csv', confidence: 0.85, reason: `delimiter ${JSON.stringify(delim)}`, delimiter: delim };

  if (nonEmpty.length >= 3 && logShare >= 0.3) {
    return { type: 'log', confidence: 0.8, reason: `${Math.round(logShare * 100)} percent log shaped lines` };
  }
  if (frames >= 3 && frameShare >= 0.25) {
    return { type: 'stacktrace', confidence: 0.6, reason: `${frames} frames` };
  }
  return { type: 'text', confidence: 0.5, reason: 'no structured shape found' };
}

function isJson(s) {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function sampleLines(src) {
  const out = [];
  let start = 0;
  while (out.length < SAMPLE_LINES && start <= src.length) {
    let end = src.indexOf('\n', start);
    if (end === -1) end = src.length;
    let line = src.slice(start, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    out.push(line);
    start = end + 1;
  }
  return out;
}

// Count delimiter occurrences outside quotes.
export function countFields(line, delim) {
  let n = 1;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === delim && !quoted) n++;
  }
  return n;
}

function csvDelimiter(lines) {
  if (lines.length < 3) return null;
  const sample = lines.slice(0, 60);
  let best = null;
  for (const d of ['\t', ',', ';', '|']) {
    const counts = sample.map((l) => countFields(l, d));
    const first = counts[0];
    if (first < 2) continue;
    const same = counts.filter((c) => c === first).length;
    if (same / counts.length >= 0.9 && (!best || first > best.fields)) best = { d, fields: first };
  }
  if (!best) return null;
  // Prose with commas can look regular for a few lines. Require short cells on average.
  const avgLen = sample.reduce((a, l) => a + l.length, 0) / sample.length / best.fields;
  if (avgLen > 60) return null;
  return best.d;
}
