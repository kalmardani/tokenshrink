import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { requestJson, redact, backoff } from '../src/provider/http.js';
import { createProvider, resolveCredentials } from '../src/provider/index.js';
import { claudeArgs, parseClaudeOutput } from '../src/provider/claude-cli.js';
import { quoteForCmd, resolveCommand, findWindowsExecutable, runProcess } from '../src/provider/subprocess.js';
import { codexArgs, parseCodexEvents } from '../src/provider/codex-cli.js';
import { resolveConfig, ConfigError } from '../src/config.js';
import { subscriptionLogin, subscriptionStatus } from '../src/auth/subscription.js';
import { tempDir, SPAWN_TIMEOUT, ROOT } from './helpers.js';

const KEY = 'sk-live-abcdefghijklmnop';
const FAKE_CLAUDE = 'tokenshrink-test-fake-claude';
const FAKE_CODEX = 'tokenshrink-test-fake-codex';

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: r.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}

const cfg = (over = {}) => ({
  provider: 'openai',
  model: 'model-x',
  baseUrl: 'http://127.0.0.1:9/v1',
  auth: { type: 'api-key', keyEnv: 'OPENAI_API_KEY', oauth: {} },
  timeoutMs: 5000,
  temperature: null,
  env: { OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: KEY },
  // Names that exist on no PATH, so a real CLI is never picked up on any OS.
  claudeBin: FAKE_CLAUDE,
  codexBin: FAKE_CODEX,
  ...over,
});

test('requestJson retries 429 and 5xx with backoff, then succeeds', async () => {
  const fetch = fakeFetch([{ status: 429, body: {}, headers: { 'retry-after': '2' } }, { status: 503, body: {} }, { status: 200, body: { ok: 1 } }]);
  const waits = [];
  const r = await requestJson('http://x/y', {}, { fetch, sleep: async (ms) => waits.push(ms), random: () => 0 });
  assert.deepEqual(r.body, { ok: 1 });
  assert.deepEqual(waits, [2000, 1000]);
});

test('requestJson stops after the retry limit and does not retry 400', async () => {
  const fetch = fakeFetch([{ status: 500, body: { error: { message: 'boom' } } }]);
  await assert.rejects(requestJson('http://x/y', {}, { fetch, retries: 2, sleep: async () => {} }), /HTTP 500 .*boom/);
  assert.equal(fetch.calls.length, 3);
  const f400 = fakeFetch([{ status: 400, body: { error: 'bad' } }]);
  await assert.rejects(requestJson('http://x/y', {}, { fetch: f400, sleep: async () => {} }), /HTTP 400/);
  assert.equal(f400.calls.length, 1);
  assert.ok(backoff(10, null, () => 0) <= 20000);
});

test('requestJson times out', { timeout: SPAWN_TIMEOUT }, async () => {
  const slow = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(requestJson('http://x', {}, { fetch: slow, timeoutMs: 20, retries: 0 }), /timed out after 20 ms/);
});

test('errors never contain keys or tokens', () => {
  assert.equal(redact(`Bearer ${KEY}`).includes(KEY), false);
  assert.equal(redact(`{"access_token":"abc123456789"}`).includes('abc123456789'), false);
  assert.equal(redact(`invalid key ${KEY}`).includes('abcdefghijklmnop'), false);
});

test('openai adapter sends bearer key, parses usage, and needs a model', async () => {
  const fetch = fakeFetch([{ status: 200, body: { model: 'model-x-2026', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } } }]);
  const p = createProvider(cfg(), { fetch });
  const r = await p.complete({ system: 's', messages: [{ role: 'user', content: 'u' }] });
  assert.equal(r.text, 'hi');
  assert.equal(r.model, 'model-x-2026');
  assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 3 });
  assert.equal(fetch.calls[0].url, 'http://127.0.0.1:9/v1/chat/completions');
  assert.equal(fetch.calls[0].init.headers.authorization, `Bearer ${KEY}`);
  const body = JSON.parse(fetch.calls[0].init.body);
  assert.deepEqual(body.messages[0], { role: 'system', content: 's' });
  await assert.rejects(createProvider(cfg({ model: null }), { fetch }).complete({ messages: [] }), ConfigError);
});

test('anthropic adapter uses x-api-key, and bearer for oauth', async () => {
  const fetch = fakeFetch([{ status: 200, body: { model: 'm', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 1 } } }]);
  const p = createProvider(cfg({ provider: 'anthropic', baseUrl: 'http://127.0.0.1:9', auth: { type: 'api-key', keyEnv: 'ANTHROPIC_API_KEY', oauth: {} } }), { fetch });
  const r = await p.complete({ system: 's', messages: [{ role: 'user', content: 'u' }] });
  assert.equal(r.text, 'ok');
  assert.equal(fetch.calls[0].url, 'http://127.0.0.1:9/v1/messages');
  assert.equal(fetch.calls[0].init.headers['x-api-key'], KEY);
  assert.equal(fetch.calls[0].init.headers['anthropic-version'], '2023-06-01');
  const noKey = createProvider(cfg({ provider: 'anthropic', env: {}, auth: { type: 'api-key', keyEnv: 'ANTHROPIC_API_KEY', oauth: {} } }), { fetch });
  await assert.rejects(noKey.complete({ messages: [] }), /set ANTHROPIC_API_KEY/);
});

test('oauth credentials come from the token cache', async () => {
  const store = new Map();
  const tokenCache = { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), delete: (k) => store.delete(k) };
  const oauth = { grant: 'pkce', tokenUrl: 'http://127.0.0.1:9/token', authUrl: 'http://127.0.0.1:9/a', clientId: 'c' };
  tokenCache.set(`${oauth.tokenUrl}|c|`, { access_token: 'tok-1', expires_at: Date.now() + 3600e3 });
  const c = await resolveCredentials(cfg({ auth: { type: 'oauth', oauth } }), { tokenCache });
  assert.deepEqual(c, { kind: 'bearer', value: 'tok-1' });
});

test('claude CLI arguments lock the model down', () => {
  const args = claudeArgs({ systemFile: '/tmp/x/system-prompt.txt', model: 'claude-x' });
  assert.equal(args[args.indexOf('--system-prompt-file') + 1], '/tmp/x/system-prompt.txt');
  assert.deepEqual(args.slice(0, 3), ['-p', '--output-format', 'json']);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.deepEqual(args.slice(-2), ['--tools', '']);
  assert.throws(() => claudeArgs({ model: 'x; rm -rf /' }), /unexpected characters/);
});

test('claude CLI output parsing reads result, usage, cost and model', () => {
  const out = JSON.stringify({
    type: 'result',
    is_error: false,
    result: '{"answer":"42"}',
    usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 5, output_tokens: 7 },
    total_cost_usd: 0.0123,
    modelUsage: { 'claude-model-1': {} },
  });
  const r = parseClaudeOutput(`noise\n${out}\n`);
  assert.equal(r.text, '{"answer":"42"}');
  assert.deepEqual(r.usage, { inputTokens: 115, outputTokens: 7 });
  assert.equal(r.costUsd, 0.0123);
  assert.equal(r.model, 'claude-model-1');
  assert.throws(() => parseClaudeOutput('garbage'), /no result/);
});

test('codex CLI arguments and event parsing', () => {
  const args = codexArgs({ dir: '/tmp/x', outFile: '/tmp/x/o.txt', model: 'm1' });
  assert.equal(args[0], 'exec');
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(args.includes('--ephemeral') && args.includes('--ignore-user-config'));
  assert.equal(args[args.length - 1], '-');
  const ev = parseCodexEvents(
    [
      '{"type":"thread.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"answer\\":\\"a\\"}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":10,"output_tokens":4}}',
    ].join('\n'),
  );
  assert.equal(ev.lastMessage, '{"answer":"a"}');
  assert.equal(ev.inputTokens, 50);
  assert.equal(ev.error, null);
});

// A spawn stand in that plays a vendor CLI.
function fakeSpawn(script) {
  const calls = [];
  const fn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    let input = '';
    child.stdin.on('data', (d) => (input += d));
    const step = script(bin, args, opts, () => input);
    setImmediate(() => {
      if (step.enoent) {
        const e = new Error('spawn ENOENT');
        e.code = 'ENOENT';
        child.emit('error', e);
        return;
      }
      if (step.file) writeFileSync(step.file.path(args), step.file.text);
      child.stdout.end(step.stdout ?? '');
      child.stderr.end(step.stderr ?? '');
      setImmediate(() => child.emit('close', step.code ?? 0));
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

test('claude-cli adapter runs the CLI with stdin prompt in a temp dir', { timeout: SPAWN_TIMEOUT }, async () => {
  const spawn = fakeSpawn(() => ({ stdout: JSON.stringify({ type: 'result', result: 'pong', usage: { input_tokens: 3, output_tokens: 1 }, total_cost_usd: 0 }) }));
  const p = createProvider(cfg({ provider: 'claude-cli', model: null, auth: { type: 'subscription', oauth: {} } }), { spawn });
  const r = await p.complete({ system: 'sys', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(r.text, 'pong');
  const call = spawn.calls[0];
  assert.equal(call.bin, FAKE_CLAUDE);
  assert.equal(call.opts.shell, false);
  assert.notEqual(call.opts.cwd, process.cwd());
  const sysIndex = call.args.indexOf('--system-prompt-file');
  assert.ok(sysIndex > 0, 'system prompt goes through a file');
  assert.ok(!call.args.includes('sys'), 'system prompt text is never an argument');
});

test('codex-cli adapter reads the last message file', { timeout: SPAWN_TIMEOUT }, async () => {
  const spawn = fakeSpawn((bin, args) => ({
    stdout: '{"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":2}}\n',
    file: { path: (a) => a[a.indexOf('-o') + 1], text: 'final answer' },
  }));
  const p = createProvider(cfg({ provider: 'codex-cli', model: null, auth: { type: 'subscription', oauth: {} } }), { spawn });
  const r = await p.complete({ messages: [{ role: 'user', content: 'q' }] });
  assert.equal(r.text, 'final answer');
  assert.equal(r.usage.inputTokens, 9);
});

// The vendor CLIs read CLAUDE.md, AGENTS.md and similar files from their working directory, so
// each call must run in its own fresh, empty folder under the OS temp dir, removed afterwards.
function insideTmp(dir) {
  const rel = relative(tmpdir(), dir);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

for (const provider of ['claude-cli', 'codex-cli']) {
  test(`${provider} runs in a fresh empty temp dir and removes it, also on error`, { timeout: SPAWN_TIMEOUT }, async () => {
    const seen = [];
    const ok = fakeSpawn((bin, args, opts) => {
      seen.push({ cwd: opts.cwd, existed: existsSync(opts.cwd), entries: readdirSync(opts.cwd).filter((f) => f !== 'system-prompt.txt') });
      return provider === 'claude-cli'
        ? { stdout: JSON.stringify({ type: 'result', result: 'pong', usage: {} }) }
        : { stdout: '{"type":"turn.completed","usage":{}}\n', file: { path: (a) => a[a.indexOf('-o') + 1], text: 'pong' } };
    });
    const conf = cfg({ provider, model: null, auth: { type: 'subscription', oauth: {} } });
    const r = await createProvider(conf, { spawn: ok }).complete({ system: 'sys', messages: [{ role: 'user', content: 'ping' }] });
    assert.equal(r.text, 'pong');

    const failing = fakeSpawn((bin, args, opts) => {
      seen.push({ cwd: opts.cwd, existed: existsSync(opts.cwd), entries: [] });
      return { code: 2, stderr: 'bad flag' };
    });
    await assert.rejects(createProvider(conf, { spawn: failing }).complete({ messages: [{ role: 'user', content: 'ping' }] }));

    assert.equal(seen.length, 2);
    for (const s of seen) {
      assert.ok(insideTmp(s.cwd), `cwd ${s.cwd} is inside ${tmpdir()}`);
      assert.notEqual(s.cwd, process.cwd());
      assert.ok(s.existed, 'the folder exists while the CLI runs');
      assert.deepEqual(s.entries, [], 'the folder holds no project files');
      assert.ok(!existsSync(s.cwd), 'the folder is gone after the call');
    }
    assert.notEqual(seen[0].cwd, seen[1].cwd, 'every call gets its own folder');
  });
}

test('subscription login checks install, probes, then starts the official sign in', { timeout: SPAWN_TIMEOUT }, async () => {
  const printed = [];
  const missing = fakeSpawn(() => ({ enoent: true }));
  let r = await subscriptionLogin('claude', FAKE_CLAUDE, { spawn: missing, print: (l) => printed.push(l) });
  assert.equal(r.installed, false);
  assert.match(printed.join('\n'), /Install the official claude CLI/);

  let signedIn = false;
  const claude = fakeSpawn((bin, args) => {
    if (args[0] === '--version') return { stdout: '9.9.9\n' };
    if (args[0] === 'auth' && args[1] === 'login') {
      signedIn = true;
      return { code: 0 };
    }
    if (args[0] === '-p') return signedIn ? { stdout: JSON.stringify({ type: 'result', result: 'ok' }) } : { code: 1, stderr: 'Not logged in' };
    return { code: 1 };
  });
  r = await subscriptionLogin('claude', FAKE_CLAUDE, { spawn: claude, print: () => {} });
  assert.equal(r.signedIn, true);
  const login = claude.calls.find((c) => c.args[0] === 'auth');
  assert.equal(login.opts.stdio, 'inherit');
  r = await subscriptionLogin('claude', FAKE_CLAUDE, { spawn: claude, print: () => {} });
  assert.equal(r.already, true);

  const codex = fakeSpawn((bin, args) => {
    if (args[0] === '--version') return { stdout: 'codex-cli 1.0\n' };
    if (args[0] === 'login' && args[1] === 'status') return { stdout: 'Logged in using ChatGPT\n' };
    return { code: 1 };
  });
  const s = await subscriptionStatus('chatgpt', FAKE_CODEX, { spawn: codex });
  assert.deepEqual({ installed: s.installed, signedIn: s.signedIn }, { installed: true, signedIn: true });
});

test('config resolution rejects secrets in the file and bad combinations', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ provider: 'openai', auth: { oauth: { clientSecret: 'x' } } }));
  assert.throws(() => resolveConfig({ config: file }, {}), /Secrets belong in env vars/);
  writeFileSync(file, JSON.stringify({ provider: 'openai', model: 'm', auth: { type: 'oauth', oauth: { grant: 'client_credentials', tokenUrl: 'http://t', clientId: 'c', clientSecretEnv: 'MY_SECRET' } } }));
  const c = resolveConfig({ config: file }, { MY_SECRET: 's3' });
  assert.equal(c.auth.type, 'oauth');
  assert.equal(c.auth.oauth.clientSecret, 's3');
  const none = { TOKENSHRINK_CONFIG: join(dir, 'missing.json') };
  assert.throws(() => resolveConfig({ provider: 'openai', auth: 'subscription' }, none), /subscription auth works only/);
  assert.throws(() => resolveConfig({ provider: 'nope' }, none), /unknown provider/);
  assert.equal(resolveConfig({}, { TOKENSHRINK_CONFIG_DIR: dir, TOKENSHRINK_CONFIG: join(dir, 'missing.json') }).provider, 'claude-cli');
  assert.equal(resolveConfig({ provider: 'openai' }, { TOKENSHRINK_API_KEY_ENV: 'GATEWAY_KEY', TOKENSHRINK_CONFIG: join(dir, 'missing.json') }).auth.keyEnv, 'GATEWAY_KEY');
});

test('Windows resolution finds .cmd shims with PATHEXT and quotes for cmd.exe', () => {
  const env = { PATH: 'C:\\Windows;C:\\Users\\A B\\AppData\\Roaming\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
  const files = new Set(['C:\\Users\\A B\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\Tools\\codex.exe']);
  const exists = (p) => files.has(p);
  assert.equal(findWindowsExecutable('claude', env, exists), 'C:\\Users\\A B\\AppData\\Roaming\\npm\\claude.cmd');
  assert.equal(findWindowsExecutable('nothing', env, exists), null);
  const r = resolveCommand('claude', ['-p', '--tools', '', '--system-prompt-file', 'C:\\Temp\\ts (1)\\s.txt'], { platform: 'win32', env, exists });
  assert.equal(r.command, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(r.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(r.options.windowsVerbatimArguments, true);
  assert.equal(
    r.args[3],
    '"^"C:\\Users\\A^ B\\AppData\\Roaming\\npm\\claude.cmd^" ^"-p^" ^"--tools^" ^"^" ^"--system-prompt-file^" ^"C:\\Temp\\ts^ ^(1^)\\s.txt^""',
  );
  const exe = resolveCommand('C:\\Tools\\codex', ['exec'], { platform: 'win32', env, exists });
  assert.deepEqual(exe, { command: 'C:\\Tools\\codex.exe', args: ['exec'], options: {} });
  assert.deepEqual(resolveCommand('claude', ['-p'], { platform: 'linux', env: {} }), { command: 'claude', args: ['-p'], options: {} });
  assert.equal(quoteForCmd('a&b|c'), '^"a^&b^|c^"');
  assert.equal(quoteForCmd('dir\\'), '^"dir\\\\^"');
  for (const bad of ['%PATH%', 'say "hi"', 'two\nlines']) assert.throws(() => quoteForCmd(bad), /cannot be passed safely/);
});

test('runProcess runs a real child, feeds stdin and kills it on timeout', { timeout: SPAWN_TIMEOUT }, async () => {
  const echo = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'hello', timeoutMs: 30000 });
  assert.equal(echo.code, 0);
  assert.equal(echo.stdout, 'hello');
  await assert.rejects(runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 }), { code: 'TIMEOUT' });
  await assert.rejects(runProcess(join(ROOT, 'no-such-binary-here'), [], { timeoutMs: 5000 }), { code: 'ENOENT' });
});
