import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compress, detect, estimateTokens, openStore, expand, parseHandle, findMarkers } from '../src/index.js';
import { splitLines } from '../src/plan.js';
import { example, rebuild } from './helpers.js';

test('estimateTokens is zero for empty text and grows with length', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('hello'), 1);
  const a = estimateTokens('the quick brown fox jumps over the lazy dog');
  assert.ok(a >= 8 && a <= 12, `got ${a}`);
  assert.ok(estimateTokens('x'.repeat(1000)) > estimateTokens('x'.repeat(100)));
  assert.equal(estimateTokens('{"a":1}'), 7);
  assert.ok(estimateTokens('日本語のテキスト') >= 8);
});

test('detect recognises every example type', () => {
  const cases = {
    'app.log': 'log',
    'users.json': 'json',
    'orders.csv': 'csv',
    'node-trace.txt': 'stacktrace',
    'java-trace.txt': 'stacktrace',
    'page.html': 'html',
    'change.diff': 'diff',
    'notes.txt': 'text',
  };
  for (const [file, type] of Object.entries(cases)) assert.equal(detect(example(file)).type, type, file);
});

test('detect handles CRLF, empty input, TSV, python traces and invalid JSON', () => {
  assert.equal(detect(example('app.log').replace(/\n/g, '\r\n')).type, 'log');
  assert.equal(detect(example('orders.csv').replace(/\n/g, '\r\n')).type, 'csv');
  assert.equal(detect('').type, 'text');
  assert.equal(detect('a\tb\tc\n1\t2\t3\n4\t5\t6\n').type, 'csv');
  assert.equal(detect('{"a": 1,').type, 'text');
  const py = ['Traceback (most recent call last):', '  File "/app/main.py", line 10, in <module>', '    main()', '  File "/app/main.py", line 6, in main', '    run()', '  File "/usr/lib/python3.12/json/__init__.py", line 3, in loads', '    raise x', 'ValueError: bad'].join('\n');
  assert.equal(detect(py).type, 'stacktrace');
});

test('handles parse in every accepted form and reject junk', () => {
  assert.deepEqual(parseHandle('[ts:ab12cd34 lines 120-480 omitted, 361 lines]'), { id: 'ab12cd34', kind: 'lines', start: 120, end: 480 });
  assert.deepEqual(parseHandle('ts:AB12CD34'), { id: 'ab12cd34', kind: 'all' });
  assert.deepEqual(parseHandle('ts:ab12cd34:5-9'), { id: 'ab12cd34', kind: 'lines', start: 5, end: 9 });
  assert.deepEqual(parseHandle('ts:ab12cd34:c5-9'), { id: 'ab12cd34', kind: 'chars', start: 5, end: 9 });
  assert.throws(() => parseHandle('ts:zz'), { code: 'BAD_HANDLE' });
  assert.throws(() => parseHandle('ts:ab12cd34:9-5'), { code: 'BAD_RANGE' });
  assert.throws(() => parseHandle("ts:ab12cd34'; drop table blobs"), { code: 'BAD_HANDLE' });
});

for (const file of ['app.log', 'node-trace.txt', 'java-trace.txt', 'change.diff', 'orders.csv']) {
  test(`compressed ${file} rebuilds the original exactly from its handles`, () => {
    const store = openStore({ memory: true });
    const original = example(file);
    for (const level of [0, 1, 2, 3, 4]) {
      const r = compress(original, { store, level });
      assert.ok(r.compressed, `${file} level ${level} compressed`);
      assert.ok(r.tokens < r.originalTokens);
      assert.deepEqual(rebuild(r.text, store), splitLines(original), `${file} level ${level}`);
    }
    store.close();
  });
}

test('CRLF input rebuilds exactly and expand returns CRLF inside spans', () => {
  const store = openStore({ memory: true });
  const original = example('app.log').replace(/\n/g, '\r\n');
  const r = compress(original, { store });
  assert.deepEqual(rebuild(r.text, store), splitLines(original));
  const m = findMarkers(r.text).find((x) => x.kind === 'lines' && x.end - x.start > 2);
  const span = expand(m.text, { store });
  assert.ok(span.includes('\r\n'));
  assert.ok(!span.endsWith('\r') && !span.endsWith('\n'));
  assert.equal(span, original.split('\r\n').slice(m.start - 1, m.end).join('\r\n'));
  store.close();
});

test('json keeps valid JSON, samples, exact omitted items and stats', () => {
  const store = openStore({ memory: true });
  const original = example('users.json');
  const r = compress(original, { store });
  const header = r.text.split('\n')[0];
  assert.match(header, /^\[tokenshrink ts:[0-9a-f]{8} json /);
  const parsed = JSON.parse(r.text.slice(header.length + 1));
  const users = parsed.users;
  assert.equal(users[0].id, 1);
  const marker = users.find((u) => typeof u === 'string' && u.startsWith('[ts:'));
  const omitted = JSON.parse(`[${expand(marker, { store })}]`);
  const all = JSON.parse(original).users;
  assert.deepEqual(omitted, all.slice(2, 999));
  const stats = users[users.length - 1];
  const admins = all.filter((u) => u.role === 'admin').length;
  assert.match(stats, new RegExp(`'admin' ${admins}`));
  assert.match(stats, /^\[stats 1000 items; id int 1\.\.1000/);
  store.close();
});

test('json long strings and wide objects point at exact source spans', () => {
  const store = openStore({ memory: true });
  const obj = { note: 'x'.repeat(5000), map: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i])) };
  const src = JSON.stringify(obj, null, 2);
  const r = compress(src, { store, type: 'json' });
  const body = JSON.parse(r.text.split('\n').slice(1).join('\n'));
  const noteMarker = findMarkers(body.note)[0];
  assert.equal(expand(noteMarker.text, { store }), JSON.stringify(obj.note));
  const keyMarker = Object.keys(body.map).find((k) => k.startsWith('[ts:'));
  const restored = JSON.parse(`{${expand(keyMarker, { store })}}`);
  assert.equal(Object.keys(restored).length + Object.keys(body.map).length - 1, 200);
  store.close();
});

test('log collapses repeats with counts and keeps every distinct error with context', () => {
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(`2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z INFO heartbeat ok seq=${i}`);
  lines.splice(150, 0, '2026-01-01T00:02:30Z ERROR disk full on /var/lib/data');
  lines.splice(100, 0, '2026-01-01T00:01:40Z WARN latency high p99=900ms');
  const store = openStore({ memory: true });
  const r = compress(lines.join('\n'), { store });
  assert.match(r.text, /ERROR disk full/);
  assert.match(r.text, /WARN latency high/);
  assert.match(r.text, /\d+x INFO heartbeat ok seq=<n>/);
  assert.ok(r.tokens < r.originalTokens / 5);
  store.close();
});

test('stack trace folds library frames and recursion', () => {
  const r = compress(example('node-trace.txt'), { store: null });
  assert.match(r.text, /RangeError: Maximum call stack size exceeded/);
  assert.match(r.text, /at buildIndex/);
  assert.match(r.text, /repeat the frame above/);
  assert.match(r.text, /library frames; express \d+/);
  assert.doesNotMatch(r.text, /body-parser\/lib/);
});

test('diff keeps changes, trims context and folds lock files', () => {
  const r = compress(example('change.diff'), { store: null });
  assert.match(r.text, /\+ {4}if \(res\.status === 429\)/);
  assert.match(r.text, /lock or generated file package-lock\.json, \+40 -20/);
  assert.doesNotMatch(r.text, /"integrity"/);
});

test('html becomes readable text and markers expand to the extracted text', () => {
  const store = openStore({ memory: true });
  const html = example('page.html');
  const r = compress(html, { store, level: 4 });
  assert.match(r.text, /^\[tokenshrink ts:[0-9a-f]{8} html/);
  assert.match(r.text, /# Rate limits & quotas/);
  assert.doesNotMatch(r.text, /__STATE__|margin:/);
  assert.equal(expand(r.handle, { store }), html);
  const m = findMarkers(r.text).find((x) => x.kind === 'lines');
  assert.ok(m, 'level 4 truncates the extracted text');
  const derived = store.get(store.resolve(m.id));
  assert.equal(derived.parent, r.hash);
  store.close();
});

test('compression is deterministic', () => {
  for (const f of ['app.log', 'users.json', 'page.html', 'orders.csv', 'change.diff']) {
    const a = compress(example(f), { store: openStore({ memory: true }) }).text;
    const b = compress(example(f), { store: openStore({ memory: true }) }).text;
    assert.equal(a, b, f);
  }
});

test('small or incompressible input passes through unchanged and is not stored', () => {
  const store = openStore({ memory: true });
  const r = compress('just a line', { store });
  assert.equal(r.compressed, false);
  assert.equal(r.text, 'just a line');
  assert.equal(store.stats().blobs, 0);
  store.close();
});

test('budget escalates levels, falls back to a skeleton, and reports when it cannot fit', () => {
  const store = openStore({ memory: true });
  const log = example('app.log');
  const r1 = compress(log, { store, budget: 1500 });
  assert.ok(r1.fits && r1.tokens <= 1500, `tokens ${r1.tokens}`);
  const r2 = compress(log, { store, budget: 120 });
  assert.ok(r2.fits && r2.tokens <= 120, `tokens ${r2.tokens}`);
  assert.equal(r2.level, 5);
  // The skeleton marker expands to lines of the compressed text, which still carry handles.
  const m = findMarkers(r2.text).find((x) => x.kind === 'lines');
  assert.ok(expand(m.text, { store }).length > 0);
  const r3 = compress(log, { store, budget: 5 });
  assert.equal(r3.fits, false);
  const small = compress('tiny', { store, budget: 10 });
  assert.equal(small.fits, true);
  assert.equal(small.compressed, false);
  store.close();
});

test('without a store markers carry no handle', () => {
  const r = compress(example('app.log'), { store: null });
  assert.equal(r.handle, null);
  assert.doesNotMatch(r.text, /ts:/);
  assert.match(r.text, /\[lines \d+-\d+ omitted/);
});
