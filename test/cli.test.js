import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, tempDir, example, SPAWN_TIMEOUT } from './helpers.js';

const BIN = join(ROOT, 'bin', 'tokenshrink.js');

function run(t, args, { input, env = {} } = {}) {
  const dir = t.dataDir ?? (t.dataDir = tempDir(t));
  const r = spawnSync(process.execPath, [BIN, ...args], {
    input,
    timeout: 30000,
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKENSHRINK_DIR: join(dir, 'data'),
      TOKENSHRINK_CONFIG_DIR: join(dir, 'config'),
      TOKENSHRINK_CLAUDE_BIN: join(dir, 'no-such-claude'),
      TOKENSHRINK_CODEX_BIN: join(dir, 'no-such-codex'),
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ...env,
    },
  });
  return r;
}

test('compress a file, then expand its handle exactly', { timeout: SPAWN_TIMEOUT }, (t) => {
  const r = run(t, ['compress', join(ROOT, 'examples', 'app.log'), '--json']);
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.type, 'log');
  assert.ok(rep.tokens < rep.originalTokens);
  const e = run(t, ['expand', rep.handle]);
  assert.equal(e.status, 0, e.stderr);
  assert.equal(e.stdout, example('app.log'));
  const marker = rep.text.split('\n').find((l) => l.startsWith('[ts:'));
  const span = run(t, ['expand', ...marker.split(' ')]);
  assert.equal(span.status, 0, span.stderr);
  assert.ok(span.stdout.length > 0);
});

test('compress reads stdin, reports stats, and the budget exit code is 3', { timeout: SPAWN_TIMEOUT }, (t) => {
  const r = run(t, ['compress', '-', '--verbose'], { input: example('users.json') });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\[tokenshrink ts:/);
  assert.match(r.stderr, /json, \d+ to \d+ tokens est\./);
  const s = run(t, ['stats', '--json']);
  assert.equal(JSON.parse(s.stdout).runs, 1);
  const b = run(t, ['compress', join(ROOT, 'examples', 'app.log'), '--budget', '3']);
  assert.equal(b.status, 3);
  assert.match(b.stderr, /cannot fit into 3 tokens/);
});

test('usage errors exit with 2 and unknown handles with 1', { timeout: SPAWN_TIMEOUT }, (t) => {
  assert.equal(run(t, ['frobnicate']).status, 2);
  assert.equal(run(t, ['compress', '--level', '9', join(ROOT, 'examples', 'app.log')]).status, 2);
  assert.equal(run(t, ['compress', '--nope']).status, 2);
  assert.equal(run(t, ['expand', 'nonsense']).status, 2);
  assert.equal(run(t, ['expand', 'ts:abcdef12']).status, 1);
  assert.equal(run(t, ['--version']).stdout.trim(), '0.1.1');
  assert.match(run(t, ['--help']).stdout, /tokenshrink compress/);
});

test('detect, forget and prune', { timeout: SPAWN_TIMEOUT }, (t) => {
  assert.match(run(t, ['detect', join(ROOT, 'examples', 'change.diff')]).stdout, /^diff\t/);
  const r = JSON.parse(run(t, ['compress', join(ROOT, 'examples', 'orders.csv'), '--json']).stdout);
  assert.match(run(t, ['forget', r.handle]).stdout, /deleted 1/);
  assert.equal(run(t, ['expand', r.handle]).status, 1);
  assert.equal(run(t, ['prune']).status, 2);
  assert.match(run(t, ['prune', '--days', '30']).stdout, /deleted 0/);
});

test('eval runs with the fake provider from the command line', { timeout: SPAWN_TIMEOUT }, (t) => {
  const r = run(t, ['eval', join(ROOT, 'examples', 'cases.jsonl'), '--provider', 'fake', '--k', '1'], {
    env: { TOKENSHRINK_FAKE_REPLY: '{"answer":"ord_77031 GATEWAY_TIMEOUT 25"}' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /log-failed-order \| log/);
  assert.match(r.stdout, /compressed {2}pass@1 100 percent/);
});

test('auth status lists every connection type without secrets', { timeout: SPAWN_TIMEOUT }, (t) => {
  const r = run(t, ['auth', 'status', '--json'], { env: { OPENAI_API_KEY: 'sk-should-not-print-123456' } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /sk-should-not-print/);
  const s = JSON.parse(r.stdout);
  assert.deepEqual(s.apiKeys.find((k) => k.env === 'OPENAI_API_KEY'), { env: 'OPENAI_API_KEY', present: true });
  assert.equal(s.oauth.configured, false);
  assert.equal(s.claudeCli.installed, false);
  assert.equal(s.codexCli.installed, false);
  const text = run(t, ['auth', 'status']);
  assert.match(text.stdout, /claude CLI not installed/);
  const login = run(t, ['auth', 'login', 'claude']);
  assert.equal(login.status, 1);
  assert.match(login.stderr, /Install the official claude CLI/);
  assert.equal(run(t, ['auth', 'login']).status, 2);
});

test('mcp server answers over stdio', { timeout: SPAWN_TIMEOUT }, (t) => {
  const input = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`;
  const r = run(t, ['mcp'], { input });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim()).result.tools[0].name, 'expand');
});
