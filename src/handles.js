// Handle syntax. A handle names a stored blob by a hex prefix of its sha256 and optionally a
// span of it. Spans are 1 based and inclusive, either whole lines or UTF-16 code units.
//
//   [ts:ab12cd34 lines 120-480 omitted, 361 lines]   marker as it appears in compressed text
//   ts:ab12cd34                                      the whole original
//   ts:ab12cd34 lines 120-480    ts:ab12cd34:120-480 a line span
//   ts:ab12cd34 chars 10-99      ts:ab12cd34:c10-99  a character span

export const MIN_ID = 8;

const LONG = /^\s*\[?\s*ts:([0-9a-f]{4,64})(?:\s+(lines|chars)\s+(\d+)-(\d+))?(?:[\s,;\]].*)?$/is;
const SHORT = /^\s*ts:([0-9a-f]{4,64}):(c?)(\d+)-(\d+)\s*$/i;

export class HandleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseHandle(input) {
  const s = String(input ?? '');
  if (s.length > 4096) throw new HandleError('BAD_HANDLE', 'handle text is too long');
  let m = SHORT.exec(s);
  if (m) {
    return span(m[1], m[2] ? 'chars' : 'lines', m[3], m[4]);
  }
  m = LONG.exec(s);
  if (!m) {
    throw new HandleError(
      'BAD_HANDLE',
      'not a tokenshrink handle. Expected text like [ts:ab12cd34 lines 120-480 omitted] or ts:ab12cd34',
    );
  }
  if (!m[2]) return { id: m[1].toLowerCase(), kind: 'all' };
  return span(m[1], m[2].toLowerCase(), m[3], m[4]);
}

function span(id, kind, a, b) {
  const start = Number(a);
  const end = Number(b);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    throw new HandleError('BAD_RANGE', `invalid range ${a}-${b}, expected 1 based start <= end`);
  }
  return { id: id.toLowerCase(), kind, start, end };
}

// Find every marker in a compressed text. Used by tests and by tools that want to expand all.
export function findMarkers(text) {
  const out = [];
  const re = /\[ts:([0-9a-f]{4,64})(?: (lines|chars) (\d+)-(\d+))?[^\]\n]*\]/g;
  for (const m of text.matchAll(re)) {
    out.push({
      text: m[0],
      index: m.index,
      id: m[1],
      kind: m[2] ?? 'all',
      start: m[3] ? Number(m[3]) : undefined,
      end: m[4] ? Number(m[4]) : undefined,
    });
  }
  return out;
}

// Offsets where each line starts, splitting on \n. A trailing \r stays part of the line
// content in the original but is excluded from the line span end below.
export function lineStarts(text) {
  const starts = [0];
  let i = text.indexOf('\n');
  while (i !== -1) {
    starts.push(i + 1);
    i = text.indexOf('\n', i + 1);
  }
  return starts;
}

export function countLines(text) {
  if (text.length === 0) return 0;
  let n = 1;
  let i = text.indexOf('\n');
  while (i !== -1) {
    n++;
    i = text.indexOf('\n', i + 1);
  }
  // A final newline does not start a new line.
  if (text.endsWith('\n')) n--;
  return n;
}

// Return the exact original substring for a span.
export function sliceSpan(text, h) {
  if (h.kind === 'all') return text;
  if (h.kind === 'chars') {
    if (h.end > text.length) {
      throw new HandleError('BAD_RANGE', `range ends at ${h.end} but the original has ${text.length} chars`);
    }
    return text.slice(h.start - 1, h.end);
  }
  const starts = lineStarts(text);
  const total = countLines(text);
  if (h.end > total) {
    throw new HandleError('BAD_RANGE', `range ends at line ${h.end} but the original has ${total} lines`);
  }
  const from = starts[h.start - 1];
  const endsWithNewline = h.end < starts.length;
  let to = endsWithNewline ? starts[h.end] - 1 : text.length;
  // Line terminators are not part of the span. For CRLF input that is the \r as well.
  if (endsWithNewline && to > from && text[to - 1] === '\r') to -= 1;
  return text.slice(from, to);
}

export function formatMarker(id, kind, start, end, summary) {
  const head = id ? `ts:${id} ` : '';
  const tail = summary ? `, ${summary}` : '';
  return `[${head}${kind} ${start}-${end} omitted${tail}]`;
}
