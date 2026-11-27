import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createProxy } from '../src/proxy.js';
import { openStore, expand, findMarkers } from '../src/index.js';
import { example, tempDir, SPAWN_TIMEOUT } from './helpers.js';

const SECRET = 'sk-test-0123456789abcdefSECRET';

function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function fakeUpstream(t, handler) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  t.after(() => closeServer(server));
  return { server, seen };
}

function send(port, { path = '/v1/chat/completions', method = 'POST', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks = [];
      const times = [];
      res.on('data', (c) => {
        chunks.push(c);
        times.push(Date.now());
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), chunks: chunks.length }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('proxy compresses large tool content, forwards auth untouched, returns the answer unchanged', { timeout: SPAWN_TIMEOUT }, async (t) => {
  const dir = tempDir(t);
  const store = openStore({ dir });
  const answer = JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'done' } }] });
  const up = fakeUpstream(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' });
    res.end(answer);
  });
  const upPort = await listen(up.server);
  const proxy = createProxy({ upstream: `http://127.0.0.1:${upPort}`, store, threshold: 500 });
  const port = await listen(proxy);
  try {
    const log = example('app.log');
    const payload = {
      model: 'm',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'what failed?' },
        { role: 'tool', tool_call_id: 'c1', content: log },
        { role: 'user', content: [{ type: 'text', text: example('users.json') }] },
      ],
    };
    const res = await send(port, { headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify(payload) });
    assert.equal(res.status, 200);
    assert.equal(res.body, answer);
    assert.equal(res.headers['x-upstream'], 'yes');
    const got = up.seen[0];
    assert.equal(got.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(got.url, '/v1/chat/completions');
    const sent = JSON.parse(got.body);
    assert.equal(sent.messages[0].content, 'be brief');
    assert.equal(sent.messages[1].content, 'what failed?');
    assert.match(sent.messages[2].content, /^\[tokenshrink ts:[0-9a-f]{8} log/);
    assert.ok(sent.messages[2].content.length < log.length / 10);
    assert.match(sent.messages[3].content[0].text, /^\[tokenshrink ts:[0-9a-f]{8} json/);
    const handle = findMarkers(sent.messages[2].content)[0];
    assert.ok(expand(handle.text, { store }).length > 0);
  } finally {
    // Close the proxy and the store before the temp dir is removed. Windows refuses to delete
    // a database file that is still open.
    await closeServer(proxy);
    store.close();
  }
  // Nothing in the store files contains the key.
  for (const f of readdirSync(dir)) {
    assert.ok(!readFileSync(join(dir, f)).toString('latin1').includes(SECRET), f);
  }
});

test('proxy streams server sent events through chunk by chunk', { timeout: SPAWN_TIMEOUT }, async (t) => {
  const up = fakeUpstream(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const timer = setInterval(() => {
      if (i < 3) res.write(`data: {"n":${i++}}\n\n`);
      else {
        clearInterval(timer);
        res.end('data: [DONE]\n\n');
      }
    }, 20);
  });
  const upPort = await listen(up.server);
  const proxy = createProxy({ upstream: `http://127.0.0.1:${upPort}`, store: null });
  t.after(() => closeServer(proxy));
  const port = await listen(proxy);
  const res = await send(port, { body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(res.body, 'data: {"n":0}\n\ndata: {"n":1}\n\ndata: {"n":2}\n\ndata: [DONE]\n\n');
  assert.ok(res.chunks >= 2, `chunks ${res.chunks}`);
  assert.equal(up.seen[0].body, JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
});

test('proxy passes other paths and non JSON bodies through untouched, keeps upstream status', { timeout: SPAWN_TIMEOUT }, async (t) => {
  const up = fakeUpstream(t, (req, res) => {
    res.writeHead(req.url.endsWith('/v1/models') ? 200 : 429, { 'content-type': 'text/plain', 'retry-after': '3' });
    res.end(req.url.endsWith('/v1/models') ? 'models' : 'slow down');
  });
  const upPort = await listen(up.server);
  const proxy = createProxy({ upstream: `http://127.0.0.1:${upPort}/prefix`, store: null, threshold: 1 });
  t.after(() => closeServer(proxy));
  const port = await listen(proxy);
  const a = await send(port, { path: '/v1/models', method: 'GET' });
  assert.equal(a.body, 'models');
  assert.equal(up.seen[0].url, '/prefix/v1/models');
  const b = await send(port, { body: 'not json at all' });
  assert.equal(b.status, 429);
  assert.equal(b.headers['retry-after'], '3');
  assert.equal(up.seen[1].body, 'not json at all');
});

test('proxy rejects foreign Host and Origin headers and oversized bodies', { timeout: SPAWN_TIMEOUT }, async (t) => {
  const up = fakeUpstream(t, (req, res) => res.end('ok'));
  const upPort = await listen(up.server);
  const proxy = createProxy({ upstream: `http://127.0.0.1:${upPort}`, store: null, maxBodyBytes: 100 });
  t.after(() => closeServer(proxy));
  const port = await listen(proxy);
  const a = await send(port, { headers: { host: 'evil.example' }, body: '{}' });
  assert.equal(a.status, 421);
  const b = await send(port, { headers: { origin: 'https://evil.example' }, body: '{}' });
  assert.equal(b.status, 403);
  const c = await send(port, { body: 'x'.repeat(500) });
  assert.equal(c.status, 413);
  assert.equal(up.seen.length, 0);
});

test('proxy answers 502 when the upstream is down', { timeout: SPAWN_TIMEOUT }, async (t) => {
  const dead = createServer();
  const deadPort = await listen(dead);
  await new Promise((r) => dead.close(r));
  const proxy = createProxy({ upstream: `http://127.0.0.1:${deadPort}`, store: null });
  t.after(() => closeServer(proxy));
  const port = await listen(proxy);
  const res = await send(port, { body: '{}' });
  assert.equal(res.status, 502);
  assert.match(res.body, /tokenshrink_proxy_error/);
});
