// Plain text compressor. Folds runs of identical lines, cuts very long lines and, from level 1
// up, keeps the start and the end of long texts. Prose gains the least of all types.

import { renderPlan, splitLines } from '../plan.js';

export const LEVELS = [
  { maxLines: Infinity, head: 0, tail: 0, maxLineChars: 2000 },
  { maxLines: 400, head: 150, tail: 50, maxLineChars: 1000 },
  { maxLines: 200, head: 80, tail: 30, maxLineChars: 500 },
  { maxLines: 100, head: 40, tail: 15, maxLineChars: 250 },
  { maxLines: 40, head: 15, tail: 5, maxLineChars: 120 },
];

export function compressText(text, level, ctx) {
  const p = LEVELS[Math.min(level, LEVELS.length - 1)];
  const lines = splitLines(text);
  const n = lines.length;
  const keep = new Uint8Array(n).fill(1);
  // Identical consecutive lines after the first one. Blank lines collapse to one.
  for (let i = 1; i < n; i++) {
    if (lines[i] === lines[i - 1]) keep[i] = 0;
  }
  if (n > p.maxLines) {
    for (let i = p.head; i < n - p.tail; i++) keep[i] = 0;
  }
  return renderPlan(lines, keep, {
    ctx,
    text,
    minOmit: 2,
    maxLineChars: p.maxLineChars,
    summarize(from, to) {
      const count = to - from + 1;
      let same = true;
      for (let k = from; k <= to; k++) if (lines[k] !== lines[from - 1]) same = false;
      if (same && from > 0) return lines[from].trim() === '' ? `${count} blank lines` : `${count} repeats of the line above`;
      let words = 0;
      for (let k = from; k <= to; k++) words += lines[k].split(/\s+/).filter(Boolean).length;
      return `${count} lines, ${words} words`;
    },
  });
}
