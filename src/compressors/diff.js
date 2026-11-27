// Unified diff compressor. File headers, hunk headers and changed lines stay. Context lines are
// trimmed to a small window around each change. Lock files and very large hunks fold into one
// marker with added and removed counts.

import { renderPlan, splitLines } from '../plan.js';

export const LEVELS = [
  { ctx: 2, maxChanged: Infinity, minOmit: 3 },
  { ctx: 1, maxChanged: 200, minOmit: 3 },
  { ctx: 0, maxChanged: 80, minOmit: 2 },
  { ctx: 0, maxChanged: 30, minOmit: 1 },
  { ctx: 0, maxChanged: 10, minOmit: 1 },
];

const LOCKFILE =
  /(?:^|[\\/])(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|uv\.lock|[\w.-]+\.min\.(?:js|css))$/;

const FILE_HEADER = /^(?:diff --git |diff -|index [0-9a-f]+\.\.|--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files )/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function compressDiff(text, level, ctx) {
  const p = LEVELS[Math.min(level, LEVELS.length - 1)];
  const lines = splitLines(text);
  const n = lines.length;
  // kind per line, h header, @ hunk, + - space context, \ marker, o other
  const kind = new Array(n).fill('o');
  const fileOf = new Array(n).fill('');
  const hunkOf = new Int32Array(n).fill(-1);
  let file = '';
  let oldLeft = 0;
  let newLeft = 0;
  let hunkIndex = -1;
  for (let i = 0; i < n; i++) {
    const l = lines[i];
    if (oldLeft > 0 || newLeft > 0) {
      const c = l[0];
      if (c === '+') {
        kind[i] = '+';
        newLeft--;
      } else if (c === '-') {
        kind[i] = '-';
        oldLeft--;
      } else if (c === '\\') {
        kind[i] = '\\';
      } else {
        kind[i] = ' ';
        oldLeft--;
        newLeft--;
      }
      fileOf[i] = file;
      hunkOf[i] = hunkIndex;
      continue;
    }
    const h = HUNK.exec(l);
    if (h) {
      kind[i] = '@';
      oldLeft = h[2] === undefined ? 1 : Number(h[2]);
      newLeft = h[4] === undefined ? 1 : Number(h[4]);
      hunkIndex++;
      fileOf[i] = file;
      hunkOf[i] = hunkIndex;
      continue;
    }
    if (l.startsWith('\\')) {
      kind[i] = '\\';
      continue;
    }
    if (FILE_HEADER.test(l)) {
      kind[i] = 'h';
      const m = /^(?:\+\+\+ |--- )(?:[ab][\\/])?(\S+)/.exec(l) ?? /^diff --git a\/(\S+)/.exec(l);
      if (m && m[1] !== '/dev/null') file = m[1];
    }
    fileOf[i] = file;
  }

  const keep = new Uint8Array(n);
  const changedInHunk = new Map();
  for (let i = 0; i < n; i++) {
    const k = kind[i];
    if (k === 'h' || k === '@' || k === 'o') {
      keep[i] = 1;
      continue;
    }
    if (LOCKFILE.test(fileOf[i])) continue;
    if (k === '+' || k === '-') {
      const c = (changedInHunk.get(hunkOf[i]) ?? 0) + 1;
      changedInHunk.set(hunkOf[i], c);
      if (c <= p.maxChanged) {
        keep[i] = 1;
        for (let j = Math.max(0, i - p.ctx); j <= Math.min(n - 1, i + p.ctx); j++) {
          if (kind[j] === ' ' && hunkOf[j] === hunkOf[i]) keep[j] = 1;
        }
      }
    } else if (k === '\\' && i > 0 && keep[i - 1]) {
      keep[i] = 1;
    }
  }

  return renderPlan(lines, keep, {
    ctx,
    text,
    minOmit: p.minOmit,
    maxLineChars: 1000,
    summarize(from, to) {
      let add = 0;
      let del = 0;
      let same = 0;
      for (let k = from; k <= to; k++) {
        if (kind[k] === '+') add++;
        else if (kind[k] === '-') del++;
        else if (kind[k] === ' ') same++;
      }
      const parts = [];
      if (LOCKFILE.test(fileOf[from])) parts.push(`lock or generated file ${fileOf[from]}`);
      if (add || del) parts.push(`+${add} -${del}`);
      if (same) parts.push(`${same} context lines`);
      return parts.join(', ') || `${to - from + 1} lines`;
    },
  });
}
