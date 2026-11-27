// Log compressor. Lines are normalised into templates (timestamps, ids, numbers replaced), the
// first occurrence of each template is shown, repeats collapse into one marker with counts,
// and error or warning lines are always shown with a few lines of context. Stack frames that
// follow an error are folded the same way the stack trace compressor folds them.

import { renderPlan, splitLines, topTemplates } from '../plan.js';
import { classifyFrame, isFrameLine } from './stacktrace.js';

export const LEVELS = [
  { head: 10, tail: 10, ctx: 3, distinct: 200, perImportant: 5, width: 80, top: 3, maxLineChars: 2000 },
  { head: 5, tail: 5, ctx: 2, distinct: 60, perImportant: 3, width: 60, top: 2, maxLineChars: 600 },
  { head: 3, tail: 3, ctx: 1, distinct: 25, perImportant: 2, width: 48, top: 2, maxLineChars: 300 },
  { head: 2, tail: 2, ctx: 1, distinct: 10, perImportant: 1, width: 40, top: 1, maxLineChars: 200 },
  { head: 1, tail: 1, ctx: 0, distinct: 0, perImportant: 1, width: 32, top: 1, maxLineChars: 120 },
];

export const IMPORTANT_RE =
  /\b(?:error|err|fatal|crit|critical|panic|panicked|exception|fail|failed|failure|failing|warn|warning|denied|refused|timed out|abort|aborted|traceback|unhandled|uncaught|segfault|oom|killed)\b/i;

export function normalizeLine(line) {
  return line
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?/g, '<ts>')
    .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\b/g, '<ts>')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<ts>')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b(?:0x)?(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compressLog(text, level, ctx) {
  const p = LEVELS[Math.min(level, LEVELS.length - 1)];
  const lines = splitLines(text);
  const n = lines.length;
  const templates = lines.map(normalizeLine);
  // Summaries read better without the leading timestamp placeholder.
  const shown = templates.map((t) => t.replace(/^(?:\[?<(?:ts|date)>\]? ?)+/, ''));
  const keep = new Uint8Array(n);
  const important = new Uint8Array(n);

  for (let i = 0; i < Math.min(p.head, n); i++) if (!isFrameLine(lines[i])) keep[i] = 1;
  for (let i = Math.max(0, n - p.tail); i < n; i++) if (!isFrameLine(lines[i])) keep[i] = 1;

  // First occurrence of each template, in order of appearance.
  const firstSeen = new Set();
  for (let i = 0; i < n; i++) {
    const t = templates[i];
    if (isFrameLine(lines[i]) || firstSeen.has(t)) continue;
    firstSeen.add(t);
    if (firstSeen.size <= p.distinct && t !== '') keep[i] = 1;
  }

  // Important lines. Each important template is shown up to perImportant times plus its last
  // occurrence, every one with context. Stack frames after it are folded.
  const seenImportant = new Map();
  const lastImportant = new Map();
  for (let i = 0; i < n; i++) {
    if (!isFrameLine(lines[i]) && IMPORTANT_RE.test(lines[i])) {
      important[i] = 1;
      lastImportant.set(templates[i], i);
    }
  }
  for (let i = 0; i < n; i++) {
    if (!important[i]) continue;
    const t = templates[i];
    const c = (seenImportant.get(t) ?? 0) + 1;
    seenImportant.set(t, c);
    if (c > p.perImportant && lastImportant.get(t) !== i) continue;
    keep[i] = 1;
    for (let k = Math.max(0, i - p.ctx); k < i; k++) if (!isFrameLine(lines[k])) keep[k] = 1;
    let k = i + 1;
    let after = 0;
    let firstFrame = true;
    while (k < n) {
      const line = lines[k];
      if (isFrameLine(line)) {
        const f = classifyFrame(line);
        if (firstFrame || !f.library) keep[k] = 1;
        firstFrame = false;
        k++;
        continue;
      }
      if (/^\s*(?:Caused by:|\.\.\. \d+ more|During handling|The above exception)/.test(line)) {
        keep[k] = 1;
        k++;
        continue;
      }
      if (after < p.ctx) {
        keep[k] = 1;
        after++;
        k++;
        continue;
      }
      break;
    }
  }

  return renderPlan(lines, keep, {
    ctx,
    text,
    minOmit: 2,
    maxLineChars: p.maxLineChars,
    summarize(from, to) {
      const count = to - from + 1;
      const parts = [`${count} lines`];
      let imp = 0;
      let frames = 0;
      for (let k = from; k <= to; k++) {
        if (important[k]) imp++;
        else if (isFrameLine(lines[k])) frames++;
      }
      if (imp) parts.push(`${imp} of them error or warning repeats`);
      if (frames) parts.push(`${frames} stack frames`);
      const { parts: top } = topTemplates(shown, from, to, p.top, p.width);
      return parts.concat(top).join('; ');
    },
  });
}
