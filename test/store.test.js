import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openStore, hashText, compress, expand } from '../src/index.js';
import { example, tempDir } from './helpers.js';

test('put and get round trip, dedupe by content, file mode 0600', (t) => {
  const dir = tempDir(t);
  const store = openStore({ dir });
  const text = 'héllo\r\nwörld\n';
  const h1 = store.put(text, { type: 'text' });
  const h2 = store.put(text, { type: 'text' });
  assert.equal(h1, h2);
  assert.equal(h1, hashText(text));
  assert.equal(store.get(h1).text, text);
  assert.equal(store.stats().blobs, 1);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(dir, 'tokenshrink.db')).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  }
  store.close();
});

test('data survives reopening the store file', (t) => {
  const dir = tempDir(t);
  let store = openStore({ dir });
  const r = compress(example('app.log'), { store });
  store.close();
  store = openStore({ dir });
  assert.equal(expand(r.handle, { store }), example('app.log'));
  store.close();
});

test('prefix resolution, ambiguity and missing handles fail closed', () => {
  const store = openStore({ memory: true });
  const a = store.put('alpha');
  assert.equal(store.resolve(a.slice(0, 8)), a);
  assert.throws(() => store.resolve('ffffffff'), { code: 'NOT_FOUND' });
  // Find two texts whose hashes share the first 4 hex chars.
  const seen = new Map();
  let pair;
  for (let i = 0; !pair; i++) {
    const h = hashText(`t${i}`);
    const p = h.slice(0, 4);
    if (seen.has(p)) pair = [seen.get(p), `t${i}`, p];
    else seen.set(p, `t${i}`);
  }
  store.put(pair[0]);
  store.put(pair[1]);
  assert.throws(() => store.resolve(pair[2]), { code: 'AMBIGUOUS' });
  assert.ok(store.shortId(hashText(pair[0])).length >= 8);
  store.close();
});

test('expand checks ranges against the original', () => {
  const store = openStore({ memory: true });
  const h = store.put('a\nb\nc\n');
  assert.equal(store.expand({ id: h.slice(0, 8), kind: 'lines', start: 2, end: 3 }).text, 'b\nc');
  assert.equal(store.expand({ id: h.slice(0, 8), kind: 'chars', start: 3, end: 3 }).text, 'b');
  assert.throws(() => store.expand({ id: h.slice(0, 8), kind: 'lines', start: 2, end: 9 }), { code: 'BAD_RANGE' });
  store.close();
});

test('forget removes a blob with its derived blobs, prune removes old ones', () => {
  const store = openStore({ memory: true });
  const r = compress(example('page.html'), { store, level: 4 });
  assert.ok(store.stats().blobs >= 2);
  assert.ok(store.forget(r.hash.slice(0, 8)) >= 1);
  assert.equal(store.stats().blobs, 0);
  assert.equal(store.stats().runs, 0);
  store.put('x');
  assert.equal(store.prune(1), 0);
  assert.equal(store.prune(0), 1);
  store.close();
});

test('stats count runs by type and source', () => {
  const store = openStore({ memory: true });
  compress(example('app.log'), { store, source: 'cli' });
  compress(example('users.json'), { store, source: 'proxy' });
  const s = store.stats();
  assert.equal(s.runs, 2);
  assert.deepEqual(s.byType.map((x) => x.type), ['json', 'log']);
  assert.deepEqual(s.bySource.map((x) => x.source), ['cli', 'proxy']);
  assert.ok(s.compressedTokens < s.originalTokens);
  store.close();
});

test('the schema has no place for headers or credentials', (t) => {
  const dir = tempDir(t);
  const store = openStore({ dir });
  store.close();
  const raw = readFileSync(join(dir, 'tokenshrink.db')).toString('latin1');
  assert.doesNotMatch(raw, /header|authorization|token_value|api_key/i);
});
