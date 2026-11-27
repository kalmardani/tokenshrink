// CSV and TSV compressor. Keeps the header, a few rows from the start and the end, one marker
// for the omitted rows, and per column statistics computed over every row.

import { renderPlan, splitLines } from '../plan.js';
import { countFields } from '../detect.js';
import { fmtNum, stringPhrase } from './stats.js';

export const LEVELS = [
  { head: 10, tail: 3, statCols: 60, top: 5 },
  { head: 5, tail: 2, statCols: 30, top: 5 },
  { head: 3, tail: 1, statCols: 15, top: 3 },
  { head: 2, tail: 1, statCols: 8, top: 3 },
  { head: 1, tail: 0, statCols: 4, top: 2 },
];

export function guessDelimiter(text) {
  const first = text.slice(0, 4000).split('\n')[0];
  let best = ',';
  let bestN = 1;
  for (const d of ['\t', ',', ';', '|']) {
    const n = countFields(first, d);
    if (n > bestN) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

// Parse records with RFC 4180 quoting. Each record remembers its first and last line index so
// rows that span several lines are kept or omitted as a whole.
export function parseRecords(lines, delim) {
  const records = [];
  let i = 0;
  while (i < lines.length) {
    const startLine = i;
    const fields = [];
    let field = '';
    let quoted = false;
    let line = lines[i];
    let k = 0;
    for (;;) {
      if (k >= line.length) {
        if (quoted && i + 1 < lines.length) {
          field += '\n';
          i++;
          line = lines[i];
          k = 0;
          continue;
        }
        fields.push(field);
        break;
      }
      const c = line[k];
      if (quoted) {
        if (c === '"' && line[k + 1] === '"') {
          field += '"';
          k += 2;
        } else if (c === '"') {
          quoted = false;
          k++;
        } else {
          field += c;
          k++;
        }
      } else if (c === '"' && field === '') {
        quoted = true;
        k++;
      } else if (c === delim) {
        fields.push(field);
        field = '';
        k++;
      } else {
        field += c;
        k++;
      }
    }
    records.push({ fields, first: startLine, last: i });
    i++;
  }
  return records;
}

export function compressCsv(text, level, ctx, opts = {}) {
  const p = LEVELS[Math.min(level, LEVELS.length - 1)];
  const delim = opts.delimiter ?? guessDelimiter(text);
  const lines = splitLines(text);
  const records = parseRecords(lines, delim).filter((r) => !(r.fields.length === 1 && r.fields[0] === '' && r.first === r.last));
  if (records.length < 2) return lines.join('\n');
  const header = records[0];
  const rows = records.slice(1);
  const keep = new Uint8Array(lines.length);
  const keepRecord = (r) => {
    for (let k = r.first; k <= r.last; k++) keep[k] = 1;
  };
  keepRecord(header);
  rows.slice(0, p.head).forEach(keepRecord);
  if (p.tail > 0) rows.slice(Math.max(p.head, rows.length - p.tail)).forEach(keepRecord);
  // Lines outside any record (blank lines) are kept so nothing is silently dropped.
  const covered = new Uint8Array(lines.length);
  for (const r of records) for (let k = r.first; k <= r.last; k++) covered[k] = 1;
  for (let k = 0; k < lines.length; k++) if (!covered[k]) keep[k] = 1;

  const lineToRecord = new Int32Array(lines.length).fill(-1);
  records.forEach((r, idx) => {
    for (let k = r.first; k <= r.last; k++) lineToRecord[k] = idx;
  });

  const body = renderPlan(lines, keep, {
    ctx,
    text,
    minOmit: 1,
    maxLineChars: 2000,
    summarize(from, to) {
      const a = lineToRecord[from];
      const b = lineToRecord[to];
      const count = a === -1 || b === -1 ? to - from + 1 : b - a + 1;
      return `${count} rows`;
    },
  });

  const names = header.fields;
  const cols = rows.reduce((m, r) => Math.max(m, r.fields.length), names.length);
  const shown = Math.min(cols, p.statCols);
  const statLines = [`[stats ${rows.length} rows x ${cols} columns]`];
  for (let c = 0; c < shown; c++) {
    const name = names[c] !== undefined && names[c] !== '' ? names[c] : `column ${c + 1}`;
    statLines.push(`${name} ${describeColumn(rows.map((r) => r.fields[c]), p.top)}`);
  }
  if (cols > shown) statLines.push(`${cols - shown} more columns without stats`);
  const ragged = rows.filter((r) => r.fields.length !== names.length).length;
  if (ragged) statLines.push(`${ragged} rows have a field count different from the header`);
  return `${body}\n${statLines.join('\n')}`;
}

const INT = /^[+-]?\d+$/;
const NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function describeColumn(values, top) {
  let empty = 0;
  const present = [];
  for (const v of values) {
    if (v === undefined || v.trim() === '') empty++;
    else present.push(v.trim());
  }
  const tail = empty ? `, ${empty} empty` : '';
  if (present.length === 0) return `empty${tail}`;
  const nums = present.filter((v) => NUM.test(v));
  if (nums.length >= present.length * 0.95) {
    const parsed = nums.map(Number);
    const ints = nums.every((v) => INT.test(v));
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const x of parsed) {
      if (x < min) min = x;
      if (x > max) max = x;
      sum += x;
    }
    const unique = new Set(parsed).size === parsed.length && parsed.length > 1 ? ', unique' : '';
    const other = present.length - nums.length;
    const otherText = other ? `, ${other} non numeric` : '';
    return `${ints ? 'int' : 'number'} ${fmtNum(min)}..${fmtNum(max)} mean ${fmtNum(sum / parsed.length)}${unique}${otherText}${tail}`;
  }
  if (present.every((v) => DATE.test(v))) {
    const sorted = [...present].sort();
    return `date ${sorted[0]}..${sorted[sorted.length - 1]}${tail}`;
  }
  const counts = new Map();
  let minLen = Infinity;
  let maxLen = 0;
  for (const v of present) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
    if (v.length < minLen) minLen = v.length;
    if (v.length > maxLen) maxLen = v.length;
  }
  return `${stringPhrase(counts, present.length, minLen, maxLen, top).replace(/^str /, 'text ')}${tail}`;
}
