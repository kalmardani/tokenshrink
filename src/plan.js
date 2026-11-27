// Shared renderer for line oriented compressors. A compressor decides which original lines to
// keep. Every maximal run of dropped lines becomes one marker that names the exact line span,
// so the kept lines plus the expanded markers rebuild the original.

import { lineStarts } from './handles.js';

export function splitLines(text) {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].endsWith('\r')) lines[i] = lines[i].slice(0, -1);
  }
  return lines;
}

// lines   original lines without terminators
// keep    Uint8Array, 1 means the line is shown
// opts.ctx            compression context with mark()
// opts.summarize      (from, to) => short summary of dropped lines, 0 based inclusive
// opts.minOmit        runs shorter than this are shown instead of marked
// opts.maxLineChars   longer kept lines are cut and the rest becomes a chars marker
// opts.keepLineChars  how many chars of a cut line stay
// opts.starts         line start offsets in the original (computed when missing)
// opts.text           the original text, needed for chars markers
export function renderPlan(lines, keep, opts) {
  const { ctx } = opts;
  const minOmit = opts.minOmit ?? 2;
  const out = [];
  const n = lines.length;
  let starts = opts.starts;
  let i = 0;
  while (i < n) {
    if (keep[i]) {
      out.push(cutLine(i));
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && !keep[j + 1]) j++;
    if (j - i + 1 < minOmit) {
      for (let k = i; k <= j; k++) out.push(cutLine(k));
    } else {
      const summary = opts.summarize ? opts.summarize(i, j) : `${j - i + 1} lines`;
      out.push(ctx.mark('lines', i + 1, j + 1, summary));
    }
    i = j + 1;
  }
  return out.join('\n');

  function cutLine(k) {
    const line = lines[k];
    const max = opts.maxLineChars;
    if (!max || line.length <= max) return line;
    if (!starts) starts = lineStarts(opts.text);
    const keepChars = Math.min(opts.keepLineChars ?? Math.floor(max / 2), line.length);
    const from = starts[k] + keepChars + 1;
    const to = starts[k] + line.length;
    return `${line.slice(0, keepChars)} ${ctx.mark('chars', from, to, `${to - from + 1} chars`)}`;
  }
}

// Short, single line preview of a line or template for summaries.
export function preview(s, max) {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 3))}...`;
}

// Count templates in a range and describe the most common ones.
export function topTemplates(templates, from, to, limit, width) {
  const counts = new Map();
  for (let k = from; k <= to; k++) {
    const t = templates[k];
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const parts = [];
  for (const [t, c] of sorted.slice(0, limit)) {
    if (!t.trim()) continue;
    parts.push(`${c}x ${preview(t, width)}`);
  }
  return { parts, distinct: counts.size };
}
