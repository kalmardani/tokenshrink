// JSON compressor. Keeps the shape, keeps a few samples of long arrays, replaces the rest with a
// marker that points at the exact original characters, and adds value statistics for the whole
// array. Output stays valid JSON, markers and statistics are string values.

import { parseJsonWithOffsets } from './json-parse.js';
import { describeValues } from './stats.js';

export const LEVELS = [
  { maxItems: 12, head: 4, tail: 1, maxString: 400, keepString: 160, maxKeys: 80, headKeys: 50, statFields: 30, pretty: true, maxDepth: 64 },
  { maxItems: 6, head: 2, tail: 1, maxString: 200, keepString: 80, maxKeys: 40, headKeys: 24, statFields: 20, pretty: true, maxDepth: 32 },
  { maxItems: 4, head: 1, tail: 1, maxString: 100, keepString: 48, maxKeys: 24, headKeys: 12, statFields: 12, pretty: false, maxDepth: 12 },
  { maxItems: 2, head: 1, tail: 0, maxString: 60, keepString: 28, maxKeys: 12, headKeys: 6, statFields: 8, pretty: false, maxDepth: 6 },
  { maxItems: 1, head: 1, tail: 0, maxString: 32, keepString: 16, maxKeys: 6, headKeys: 3, statFields: 4, pretty: false, maxDepth: 4 },
];

const INLINE_WIDTH = 100;

export function compressJson(text, level, ctx) {
  const p = LEVELS[Math.min(level, LEVELS.length - 1)];
  const root = parseJsonWithOffsets(text);
  return render(root, 0);

  function mark(kind, a, b, summary) {
    return JSON.stringify(ctx.mark(kind, a, b, summary));
  }

  function render(node, depth) {
    switch (node.kind) {
      case 'string':
        return renderString(node);
      case 'number':
      case 'bool':
      case 'null':
        return node.raw;
      case 'array':
        if (depth >= p.maxDepth && node.items.length) {
          return mark('chars', node.start + 1, node.end, `array of ${node.items.length} items`);
        }
        return renderArray(node, depth);
      case 'object':
        if (depth >= p.maxDepth && node.entries.length) {
          return mark('chars', node.start + 1, node.end, `object with ${node.entries.length} keys`);
        }
        return renderObject(node, depth);
      default:
        throw new Error(`unknown node kind ${node.kind}`);
    }
  }

  function renderString(node) {
    const v = node.value;
    if (v.length <= p.maxString) return node.raw;
    const m = ctx.mark('chars', node.start + 1, node.end, `string of ${v.length} chars`);
    return JSON.stringify(`${v.slice(0, p.keepString)} ${m}`);
  }

  function renderArray(node, depth) {
    const items = node.items;
    const n = items.length;
    if (n <= p.maxItems) {
      return wrap('[', ']', items.map((it) => render(it, depth + 1)));
    }
    const headN = Math.min(p.head, n);
    const tailN = Math.min(p.tail, n - headN);
    const parts = [];
    for (let k = 0; k < headN; k++) parts.push(render(items[k], depth + 1));
    const from = headN;
    const to = n - tailN - 1;
    if (to >= from) {
      parts.push(
        mark('chars', items[from].start + 1, items[to].end, `items ${from + 1}-${to + 1} of ${n}`),
      );
    }
    for (let k = n - tailN; k < n; k++) parts.push(render(items[k], depth + 1));
    parts.push(JSON.stringify(`[stats ${n} items; ${arrayStats(items)}]`));
    return wrap('[', ']', parts);
  }

  function arrayStats(items) {
    const values = items.map((it) => JSON.parse(text.slice(it.start, it.end)));
    const objects = values.filter((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
    if (objects.length >= values.length * 0.8) {
      const fields = [];
      const seen = new Set();
      for (const o of objects) {
        for (const k of Object.keys(o)) {
          if (!seen.has(k)) {
            seen.add(k);
            fields.push(k);
          }
        }
      }
      const shown = fields.slice(0, p.statFields);
      const phrases = [];
      for (const f of shown) {
        const vals = objects.map((o) => (Object.hasOwn(o, f) ? o[f] : undefined));
        const nested = vals.filter((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
        if (nested.length === vals.length && nested.length > 0) {
          // One level of nested objects is described field by field.
          const sub = [...new Set(nested.flatMap((o) => Object.keys(o)))].slice(0, p.statFields);
          for (const k of sub) phrases.push(`${f}.${k} ${describeValues(nested.map((o) => (Object.hasOwn(o, k) ? o[k] : undefined)))}`);
        } else phrases.push(`${f} ${describeValues(vals)}`);
      }
      if (fields.length > shown.length) phrases.push(`${fields.length - shown.length} more fields`);
      if (objects.length < values.length) phrases.push(`${values.length - objects.length} non objects`);
      return phrases.join('; ');
    }
    return describeValues(values);
  }

  function renderObject(node, depth) {
    const entries = node.entries;
    const n = entries.length;
    const parts = [];
    const shownN = n > p.maxKeys ? p.headKeys : n;
    for (let k = 0; k < shownN; k++) {
      parts.push(keyValue(entries[k].keyRaw, render(entries[k].value, depth + 1)));
    }
    if (shownN < n) {
      const rest = entries.slice(shownN);
      const m = ctx.mark('chars', rest[0].start + 1, rest[rest.length - 1].value.end, `${rest.length} more keys`);
      const values = rest.map((e) => JSON.parse(text.slice(e.value.start, e.value.end)));
      parts.push(keyValue(JSON.stringify(m), JSON.stringify(describeValues(values))));
    }
    return wrap('{', '}', parts);
  }

  function keyValue(k, v) {
    return p.pretty ? `${k}: ${v}` : `${k}:${v}`;
  }

  function wrap(open, close, parts) {
    if (parts.length === 0) return open + close;
    if (!p.pretty) return open + parts.join(',') + close;
    const inline = `${open}${parts.join(', ')}${close}`;
    if (inline.length <= INLINE_WIDTH && !inline.includes('\n')) return inline;
    const body = parts.map((s) => `  ${s.replace(/\n/g, '\n  ')}`).join(',\n');
    return `${open}\n${body}\n${close}`;
  }
}
