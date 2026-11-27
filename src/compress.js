// Orchestration. Detects the type, runs the compressor at a level, escalates the level in
// budget mode, and as a last resort keeps the head and tail of the compressed text. Blobs are
// written to the store only when the result actually references them.

import { detect, TYPES } from './detect.js';
import { estimateTokens } from './tokens.js';
import { countLines, formatMarker, MIN_ID } from './handles.js';
import { hashText } from './store.js';
import { splitLines } from './plan.js';
import { compressJson } from './compressors/json.js';
import { compressLog } from './compressors/log.js';
import { compressStacktrace } from './compressors/stacktrace.js';
import { compressHtml } from './compressors/html.js';
import { compressCsv } from './compressors/csv.js';
import { compressDiff } from './compressors/diff.js';
import { compressText } from './compressors/text.js';

export const DEFAULT_LEVEL = 1;
export const MAX_LEVEL = 4;

const COMPRESSORS = {
  json: compressJson,
  log: compressLog,
  stacktrace: compressStacktrace,
  html: compressHtml,
  csv: compressCsv,
  diff: compressDiff,
  text: compressText,
};

// opts.store    store from openStore, or null to emit markers without handles
// opts.type     force a type instead of detecting
// opts.level    starting level 0..4, default 1
// opts.budget   target estimated tokens
// opts.header   include the one line header, default true
// opts.source   recorded in stats (api, cli, proxy, mcp, eval)
export function compress(input, opts = {}) {
  const text = String(input ?? '');
  const store = opts.store ?? null;
  const detected = opts.type ? { type: opts.type, reason: 'forced' } : detect(text);
  if (!TYPES.includes(detected.type)) throw new Error(`unknown type ${detected.type}, expected one of ${TYPES.join(', ')}`);
  const originalTokens = estimateTokens(text);
  const budget = opts.budget === undefined || opts.budget === null ? null : Number(opts.budget);
  if (budget !== null && (!Number.isFinite(budget) || budget < 1)) throw new Error('budget must be a positive number');
  const startLevel = clampLevel(opts.level ?? DEFAULT_LEVEL);
  const header = opts.header !== false;

  const base = {
    text,
    type: detected.type,
    reason: detected.reason,
    compressed: false,
    level: null,
    originalTokens,
    tokens: originalTokens,
    fits: budget === null ? true : originalTokens <= budget,
    handle: null,
    hash: null,
  };
  if (text.length === 0 || (budget !== null && originalTokens <= budget)) return base;

  const hash = hashText(text);
  let attempt;
  let type = detected.type;
  for (let level = startLevel; level <= MAX_LEVEL; level++) {
    attempt = runLevel(text, type, level, hash, store, detected, header);
    if (attempt.failed && type !== 'text') {
      // A malformed document of the detected type falls back to plain text.
      type = 'text';
      attempt = runLevel(text, type, level, hash, store, detected, header);
    }
    if (budget === null || attempt.tokens <= budget) break;
  }

  if (budget === null && attempt.tokens >= originalTokens) return base;

  if (budget !== null && attempt.tokens > budget) {
    const skeleton = skeletonFit(attempt, budget, hash, store, type, header, originalTokens);
    if (skeleton) attempt = skeleton;
    else if (attempt.tokens >= originalTokens) return { ...base, fits: false };
  }

  // Commit the blobs the output references, then record the run.
  let handle = null;
  if (store) {
    store.put(text, { hash, type });
    for (const d of attempt.derived) if (d.used) store.put(d.text, { hash: d.hash, type: d.type, parent: hash });
    handle = `ts:${attempt.ids.get(hash)}`;
    store.recordRun({
      hash,
      source: opts.source ?? 'api',
      type,
      level: attempt.level,
      originalTokens,
      compressedTokens: attempt.tokens,
    });
  }
  return {
    text: attempt.output,
    type,
    reason: detected.reason,
    compressed: true,
    level: attempt.level,
    originalTokens,
    tokens: attempt.tokens,
    fits: budget === null ? true : attempt.tokens <= budget,
    handle,
    hash,
  };
}

function clampLevel(l) {
  const n = Number(l);
  if (!Number.isInteger(n) || n < 0 || n > MAX_LEVEL) throw new Error(`level must be an integer from 0 to ${MAX_LEVEL}`);
  return n;
}

function makeContext(hash, store, derived, ids) {
  const idFor = (h) => {
    if (!store) return null;
    if (!ids.has(h)) ids.set(h, store.has(h) ? store.shortId(h) : shortIdFresh(store, h));
    return ids.get(h);
  };
  const ctx = {
    mark(kind, start, end, summary) {
      const clean = summary ? String(summary).replace(/[[\]]/g, (c) => (c === '[' ? '(' : ')')).replace(/[\r\n]+/g, ' ') : '';
      return formatMarker(idFor(hash), kind, start, end, clean);
    },
    derive(text, type) {
      const h = hashText(text);
      const entry = { hash: h, text, type, used: false };
      derived.push(entry);
      const sub = makeContext(h, store, derived, ids);
      const mark = sub.mark;
      sub.mark = (...args) => {
        entry.used = true;
        return mark(...args);
      };
      return sub;
    },
  };
  return ctx;
}

// Short id for a hash that is not stored yet. It must not collide with any stored blob.
function shortIdFresh(store, hash) {
  for (let len = MIN_ID; len < 64; len += 2) {
    const p = hash.slice(0, len);
    try {
      store.resolve(p);
    } catch (e) {
      if (e.code === 'NOT_FOUND') return p;
    }
  }
  return hash;
}

function runLevel(text, type, level, hash, store, detected, header) {
  const derived = [];
  const ids = new Map();
  const ctx = makeContext(hash, store, derived, ids);
  let body;
  try {
    body = COMPRESSORS[type](text, level, ctx, { delimiter: detected.delimiter });
  } catch (err) {
    if (type === 'text') throw err;
    return { failed: true, error: err };
  }
  // The header always names the original, so make sure it has an id.
  if (store && !ids.has(hash)) ctx.mark('lines', 1, 1);
  const output = header ? withHeader(ids.get(hash), type, estimateTokens(text), body) : body;
  return { output, body, tokens: estimateTokens(output), level, derived, ids, failed: false };
}

// The header states the size of the whole output, itself included. Two passes settle it.
function withHeader(id, type, from, body) {
  const bodyTokens = estimateTokens(body);
  const first = headerLine(id, type, from, bodyTokens);
  const total = estimateTokens(first) + 1 + bodyTokens;
  return `${headerLine(id, type, from, total)}\n${body}`;
}

export function headerLine(id, type, from, to) {
  const handle = id ? `ts:${id} ` : '';
  const restore = id ? ', expand a ts: handle to restore any omitted part' : '';
  return `[tokenshrink ${handle}${type} ${from} to ${to} tokens est.${restore}]`;
}

// Last resort in budget mode. Keep the head and the tail lines of the compressed body and mark
// the middle against the compressed body, stored as a derived blob.
function skeletonFit(attempt, budget, hash, store, type, header, originalTokens) {
  const body = attempt.body;
  const lines = splitLines(body);
  const n = lines.length;
  const derived = [...attempt.derived];
  const ids = new Map(attempt.ids);
  const ctx = makeContext(hash, store, derived, ids);
  const sub = ctx.derive(body, type === 'json' ? 'json' : 'text');
  if (store && !ids.has(hash)) ctx.mark('lines', 1, 1);
  const total = countLines(body);
  const build = (keepN) => {
    const headN = Math.ceil(keepN * 0.7);
    const tailN = keepN - headN;
    const out = lines.slice(0, headN);
    if (headN + tailN < n) out.push(sub.mark('lines', headN + 1, n - tailN, `${n - tailN - headN} lines of the compressed text`));
    out.push(...lines.slice(n - tailN));
    const text = out.join('\n');
    const full = header ? withHeader(ids.get(hash), type, originalTokens, text) : text;
    return { full, tokens: estimateTokens(full) };
  };
  // Binary search the largest number of kept lines that fits.
  let lo = 0;
  let hi = Math.max(0, Math.min(n - 1, total));
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = build(mid);
    if (r.tokens <= budget) {
      best = r;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (!best) return null;
  return { output: best.full, body: best.full, tokens: best.tokens, level: MAX_LEVEL + 1, derived, ids, failed: false };
}
