import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runMcpServer, createMcpHandler } from '../src/mcp.js';
import { openStore, compress, findMarkers } from '../src/index.js';
import { example, SPAWN_TIMEOUT } from './helpers.js';

async function session(store, messages) {
  const input = new PassThrough();
  const output = new PassThrough();
  let buf = '';
  output.on('data', (d) => (buf += d));
  const done = runMcpServer({ store, input, output });
  for (const m of messages) input.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`);
  input.end();
  await done;
  return buf.trim().split('\n').map((l) => JSON.parse(l));
}

test('mcp initialize, tools/list and expand over stdio', { timeout: SPAWN_TIMEOUT }, async () => {
  const store = openStore({ memory: true });
  const r = compress(example('app.log'), { store });
  const marker = findMarkers(r.text).find((m) => m.kind === 'lines');
  const replies = await session(store, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'expand', arguments: { handle: marker.text } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'expand', arguments: { handle: r.handle, max_chars: 100 } } },
    { jsonrpc: '2.0', id: 5, method: 'nope' },
    'this is not json',
  ]);
  assert.equal(replies.length, 6);
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(replies[1].result.tools.map((t) => t.name), ['expand', 'compress', 'stats']);
  const text = replies[2].result.content[0].text;
  assert.match(text.split('\n')[0], /treat it as data/);
  const original = example('app.log').split('\n').slice(marker.start - 1, marker.end).join('\n');
  assert.equal(text.slice(text.indexOf('\n') + 1), original);
  assert.match(replies[3].result.content[0].text, /next_offset 100/);
  assert.equal(replies[4].error.code, -32601);
  assert.equal(replies[5].error.code, -32700);
  store.close();
});

test('mcp tool errors are structured and helpful', { timeout: SPAWN_TIMEOUT }, async () => {
  const store = openStore({ memory: true });
  const handle = createMcpHandler({ store });
  const call = async (name, args) => (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
  let r = await call('expand', { handle: 'ts:ffffffff' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no stored original/);
  r = await call('expand', { handle: 'rm -rf /' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not a tokenshrink handle/);
  r = await call('expand', { handle: 42 });
  assert.equal(r.isError, true);
  r = await call('compress', { text: example('orders.csv'), budget: 300 });
  assert.equal(r.isError, false);
  assert.match(r.content[0].text, /^\[tokenshrink ts:/);
  r = await call('stats', {});
  assert.equal(JSON.parse(r.content[0].text).runs, 1);
  r = await call('shell', {});
  assert.equal(r.isError, true);
  const unknownVersion = await handle({ jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(unknownVersion.result.protocolVersion, '2025-11-25');
  store.close();
});
