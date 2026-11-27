#!/usr/bin/env node
// tokenshrink command line interface.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;

// node:sqlite needs a flag on Node 22.5 to 22.12 and 23.0 to 23.3. Re-run once with it.
const [major, minor] = process.versions.node.split('.').map(Number);
const needsFlag = (major === 22 && minor < 13) || (major === 23 && minor < 4);
if (needsFlag && !process.execArgv.includes('--experimental-sqlite')) {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}

const EXIT = { ok: 0, error: 1, usage: 2, budget: 3, gate: 4 };

const HELP = `tokenshrink ${VERSION}, lossless context compression for AI agents

Usage
  tokenshrink compress <file|->      compress a file or stdin, print the result
  tokenshrink expand <handle>        print the exact original behind a handle
  tokenshrink detect <file|->        print the detected content type
  tokenshrink stats                  stored originals and tokens saved
  tokenshrink forget <handle>        delete one stored original
  tokenshrink prune --days N         delete originals older than N days
  tokenshrink proxy --upstream URL   local proxy for chat completions
  tokenshrink mcp                    MCP server on stdio
  tokenshrink eval <cases.jsonl>     compare answers on original and compressed context
  tokenshrink auth login [claude|chatgpt]
  tokenshrink auth status
  tokenshrink auth logout

Common options
  --data-dir DIR     store location (default TOKENSHRINK_DIR or ~/.tokenshrink)
  --no-store         do not store originals (markers then carry no handle)
  -h, --help         this help
  -v, --version      version

compress options
  --type T           json, log, stacktrace, html, csv, diff or text
  --level N          0 gentle to 4 hardest, default 1
  --budget N         compress harder until the estimate fits N tokens, exit 3 if it cannot
  --no-header        omit the first summary line
  --json             print a JSON report with the text
  --verbose          print a one line summary to stderr

proxy options
  --upstream URL     upstream base URL, or TOKENSHRINK_UPSTREAM (for example https://api.openai.com)
  --port N           default 8787
  --host H           default 127.0.0.1
  --threshold N      compress content above N estimated tokens, default 1000
  --roles LIST       roles to compress, default tool,function,user
  --budget N         budget per compressed content part
  --level N          compression level
  --allow-origin O   allow browser requests from this origin (repeatable)
  --max-body-mb N    request body limit, default 32
  --timeout-ms N     upstream idle timeout, default 600000

eval options
  --k N              runs per variant, default 3
  --provider P       openai, anthropic, claude-cli, codex-cli or fake
  --model M          model id for the provider
  --base-url URL     base URL for the openai provider
  --auth A           api-key, oauth, subscription or none
  --config FILE      config file (default in the user config dir)
  --level N, --budget N, --json
  --gate             exit 4 when compressed pass^k is below original pass^k

auth options
  --grant G          client_credentials, pkce or device (overrides the config)
  --no-browser       print the sign in URL without opening a browser
  --json             machine readable status
`;

function fail(code, message) {
  process.stderr.write(`tokenshrink: ${message}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const command = argv[0];
if (!command || command === '-h' || command === '--help' || command === 'help') {
  process.stdout.write(HELP);
  process.exit(EXIT.ok);
}
if (command === '-v' || command === '--version') {
  process.stdout.write(`${VERSION}\n`);
  process.exit(EXIT.ok);
}

const storeOpts = {
  'data-dir': { type: 'string' },
  'no-store': { type: 'boolean' },
};

function parse(options, args, allowPositionals = true) {
  try {
    return parseArgs({ args, options: { ...options, help: { type: 'boolean', short: 'h' } }, allowPositionals, strict: true });
  } catch (err) {
    fail(EXIT.usage, `${err.message}. See tokenshrink --help`);
  }
  return null;
}

function intOpt(v, name, min = 0) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) fail(EXIT.usage, `${name} must be an integer >= ${min}`);
  return n;
}

async function readInput(arg) {
  if (!arg) fail(EXIT.usage, 'give a file path or - for stdin');
  if (arg === '-') {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }
  try {
    return readFileSync(arg, 'utf8');
  } catch (err) {
    fail(EXIT.error, `cannot read ${arg}: ${err.code ?? err.message}`);
  }
  return '';
}

async function openStoreFor(values) {
  if (values['no-store']) return null;
  const { openStore } = await import('../src/store.js');
  try {
    return openStore({ dir: values['data-dir'] });
  } catch (err) {
    fail(EXIT.error, err.message);
  }
  return null;
}

async function main() {
  const rest = argv.slice(1);
  switch (command) {
    case 'compress': {
      const { values, positionals } = parse(
        {
          ...storeOpts,
          type: { type: 'string' },
          level: { type: 'string' },
          budget: { type: 'string' },
          'no-header': { type: 'boolean' },
          json: { type: 'boolean' },
          verbose: { type: 'boolean' },
        },
        rest,
      );
      if (values.help) return help();
      const { compress } = await import('../src/compress.js');
      const text = await readInput(positionals[0]);
      const store = await openStoreFor(values);
      let r;
      try {
        r = compress(text, {
          store,
          type: values.type,
          level: intOpt(values.level, '--level'),
          budget: intOpt(values.budget, '--budget', 1),
          header: !values['no-header'],
          source: 'cli',
        });
      } catch (err) {
        fail(EXIT.usage, err.message);
      } finally {
        store?.close();
      }
      if (values.json) {
        const { text: out, ...meta } = r;
        process.stdout.write(`${JSON.stringify({ ...meta, text: out }, null, 2)}\n`);
      } else {
        process.stdout.write(r.text.endsWith('\n') ? r.text : `${r.text}\n`);
      }
      if (values.verbose) {
        const saved = r.originalTokens ? Math.round(((r.originalTokens - r.tokens) / r.originalTokens) * 1000) / 10 : 0;
        process.stderr.write(`tokenshrink ${r.type}, ${r.originalTokens} to ${r.tokens} tokens est. (${saved} percent saved), level ${r.level ?? 'none'}\n`);
      }
      if (!r.fits) fail(EXIT.budget, `cannot fit into ${values.budget} tokens, the smallest result is about ${r.tokens}`);
      return;
    }
    case 'expand': {
      const { values, positionals } = parse({ 'data-dir': { type: 'string' } }, rest);
      if (values.help) return help();
      if (positionals.length === 0) fail(EXIT.usage, 'give a handle, for example tokenshrink expand ts:ab12cd34:120-480');
      const { parseHandle } = await import('../src/handles.js');
      let h;
      try {
        h = parseHandle(positionals.join(' '));
      } catch (err) {
        fail(EXIT.usage, err.message);
      }
      const store = await openStoreFor(values);
      try {
        process.stdout.write(store.expand(h).text);
      } catch (err) {
        fail(EXIT.error, err.message);
      } finally {
        store.close();
      }
      return;
    }
    case 'detect': {
      const { values, positionals } = parse({}, rest);
      if (values.help) return help();
      const { detect } = await import('../src/detect.js');
      const r = detect(await readInput(positionals[0]));
      process.stdout.write(`${r.type}\t${r.reason}\n`);
      return;
    }
    case 'stats': {
      const { values } = parse({ 'data-dir': { type: 'string' }, json: { type: 'boolean' } }, rest, false);
      if (values.help) return help();
      const store = await openStoreFor(values);
      const s = store.stats();
      store.close();
      if (values.json) {
        process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
        return;
      }
      const pct = (o, c) => (o ? `${Math.round(((o - c) / o) * 1000) / 10} percent` : 'n/a');
      const lines = [
        `store ${s.file}`,
        `originals ${s.blobs}, ${s.chars} chars, ${s.storedBytes} bytes on disk`,
        `runs ${s.runs}, ${s.originalTokens} to ${s.compressedTokens} tokens est., ${pct(s.originalTokens, s.compressedTokens)} saved`,
      ];
      for (const t of s.byType) lines.push(`  ${t.type} ${t.runs} runs, ${t.original} to ${t.compressed} tokens est.`);
      process.stdout.write(`${lines.join('\n')}\n`);
      return;
    }
    case 'forget': {
      const { values, positionals } = parse({ 'data-dir': { type: 'string' } }, rest);
      if (values.help) return help();
      const { parseHandle } = await import('../src/handles.js');
      let h;
      try {
        h = parseHandle(positionals.join(' '));
      } catch (err) {
        fail(EXIT.usage, err.message);
      }
      const store = await openStoreFor(values);
      try {
        const n = store.forget(h.id);
        process.stdout.write(`deleted ${n} stored blobs\n`);
      } catch (err) {
        fail(EXIT.error, err.message);
      } finally {
        store.close();
      }
      return;
    }
    case 'prune': {
      const { values } = parse({ 'data-dir': { type: 'string' }, days: { type: 'string' } }, rest, false);
      if (values.help) return help();
      const days = intOpt(values.days, '--days');
      if (days === undefined) fail(EXIT.usage, 'prune needs --days N');
      const store = await openStoreFor(values);
      const n = store.prune(days);
      store.close();
      process.stdout.write(`deleted ${n} stored blobs older than ${days} days\n`);
      return;
    }
    case 'proxy': {
      const { values } = parse(
        {
          ...storeOpts,
          upstream: { type: 'string' },
          port: { type: 'string' },
          host: { type: 'string' },
          threshold: { type: 'string' },
          roles: { type: 'string' },
          budget: { type: 'string' },
          level: { type: 'string' },
          'allow-origin': { type: 'string', multiple: true },
          'max-body-mb': { type: 'string' },
          'timeout-ms': { type: 'string' },
        },
        rest,
        false,
      );
      if (values.help) return help();
      const upstream = values.upstream ?? process.env.TOKENSHRINK_UPSTREAM;
      if (!upstream) fail(EXIT.usage, 'proxy needs --upstream URL or TOKENSHRINK_UPSTREAM');
      const { createProxy, isLoopback } = await import('../src/proxy.js');
      const host = values.host ?? '127.0.0.1';
      const port = intOpt(values.port, '--port') ?? 8787;
      const store = await openStoreFor(values);
      let server;
      try {
        server = createProxy({
          upstream,
          store,
          threshold: intOpt(values.threshold, '--threshold') ?? 1000,
          roles: values.roles ? values.roles.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          budget: intOpt(values.budget, '--budget', 1),
          level: intOpt(values.level, '--level'),
          allowOrigins: values['allow-origin'],
          maxBodyBytes: (intOpt(values['max-body-mb'], '--max-body-mb', 1) ?? 32) * 1024 * 1024,
          timeoutMs: intOpt(values['timeout-ms'], '--timeout-ms', 1000),
          checkHost: isLoopback(host),
          log: (line) => process.stderr.write(`tokenshrink proxy ${line}\n`),
        });
      } catch (err) {
        fail(EXIT.usage, err.message);
      }
      if (!isLoopback(host)) process.stderr.write(`tokenshrink proxy WARNING binding to ${host}, other machines can reach it\n`);
      server.on('error', (err) => fail(EXIT.error, `proxy cannot listen: ${err.message}`));
      server.listen(port, host, () => {
        const a = server.address();
        process.stderr.write(`tokenshrink proxy listening on http://${host.includes(':') ? `[${host}]` : host}:${a.port} forwarding to ${new URL(upstream).origin}\n`);
      });
      const stop = () => {
        server.close();
        store?.close();
        process.exit(EXIT.ok);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'mcp': {
      const { values } = parse({ 'data-dir': { type: 'string' } }, rest, false);
      if (values.help) return help();
      const { runMcpServer } = await import('../src/mcp.js');
      const store = await openStoreFor(values);
      await runMcpServer({ store, log: (l) => process.stderr.write(`tokenshrink mcp ${l}\n`) });
      store.close();
      return;
    }
    case 'eval': {
      const { values, positionals } = parse(
        {
          k: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          'base-url': { type: 'string' },
          auth: { type: 'string' },
          config: { type: 'string' },
          level: { type: 'string' },
          budget: { type: 'string' },
          json: { type: 'boolean' },
          gate: { type: 'boolean' },
        },
        rest,
      );
      if (values.help) return help();
      if (!positionals[0]) fail(EXIT.usage, 'eval needs a cases.jsonl file');
      const { loadCases, runEval, formatReport, EvalError } = await import('../src/eval.js');
      const { resolveConfig, ConfigError } = await import('../src/config.js');
      const { createProvider } = await import('../src/provider/index.js');
      const { openStore } = await import('../src/store.js');
      let cases;
      let config;
      try {
        cases = loadCases(positionals[0]);
        config = resolveConfig({ provider: values.provider, model: values.model, baseUrl: values['base-url'], auth: values.auth, config: values.config });
      } catch (err) {
        fail(err instanceof EvalError || err instanceof ConfigError ? EXIT.usage : EXIT.error, err.message);
      }
      if (config.provider === 'fake' && process.env.TOKENSHRINK_FAKE_REPLY) {
        const { createFakeProvider } = await import('../src/provider/fake.js');
        config.fakeProvider = createFakeProvider([process.env.TOKENSHRINK_FAKE_REPLY]);
      }
      const provider = createProvider(config, { fake: config.fakeProvider });
      const store = openStore({ memory: true });
      const rep = await runEval({
        cases,
        provider,
        k: intOpt(values.k, '--k', 1) ?? 3,
        level: intOpt(values.level, '--level'),
        budget: intOpt(values.budget, '--budget', 1),
        store,
        onProgress: (p) => process.stderr.write(`tokenshrink eval ${p.id} ${p.variant} run ${p.run}/${p.k}\n`),
      });
      store.close();
      process.stdout.write(values.json ? `${JSON.stringify(rep, null, 2)}\n` : `${formatReport(rep)}\n`);
      const t = rep.totals;
      if (t.original.errors + t.compressed.errors === rep.cases.length * rep.k * 2) fail(EXIT.error, 'every model call failed');
      if (values.gate && t.compressed.passK < t.original.passK) fail(EXIT.gate, 'compressed pass^k is below original pass^k');
      return;
    }
    case 'auth':
      return authCommand(rest);
    default:
      fail(EXIT.usage, `unknown command ${command}. See tokenshrink --help`);
  }
}

async function authCommand(args) {
  const { values, positionals } = parse(
    {
      grant: { type: 'string' },
      'no-browser': { type: 'boolean' },
      json: { type: 'boolean' },
      config: { type: 'string' },
      provider: { type: 'string' },
    },
    args,
  );
  if (values.help) return help();
  const [sub, target] = positionals;
  const { resolveConfig, ConfigError } = await import('../src/config.js');
  const oauth = await import('../src/auth/oauth.js');
  const subscription = await import('../src/auth/subscription.js');
  let config;
  try {
    // Auth commands look at every connection type, so the provider choice does not matter.
    config = resolveConfig({ config: values.config, provider: values.provider ?? 'openai', auth: 'api-key' });
  } catch (err) {
    fail(err instanceof ConfigError ? EXIT.usage : EXIT.error, err.message);
  }
  const oauthCfg = { ...config.auth.oauth, grant: values.grant ?? config.auth.oauth.grant };
  const binFor = (v) => (v === 'claude' ? config.claudeBin : config.codexBin);

  if (sub === 'login') {
    if (target === 'claude' || target === 'chatgpt') {
      const r = await subscription.subscriptionLogin(target, binFor(target));
      if (!r.signedIn) process.exit(EXIT.error);
      return;
    }
    if (target) fail(EXIT.usage, 'auth login takes no target for OAuth, or claude, or chatgpt');
    try {
      const s = await oauth.login(oauthCfg, { openBrowser: !values['no-browser'] });
      process.stdout.write(`signed in with ${s.grant}, token valid until ${s.expiresAt}${s.hasRefreshToken ? ', refresh token cached' : ''}\n`);
    } catch (err) {
      fail(err.code === 'BAD_CONFIG' ? EXIT.usage : EXIT.error, err.message);
    }
    return;
  }
  if (sub === 'logout') {
    if (target === 'claude' || target === 'chatgpt') {
      const cmd = target === 'claude' ? `${config.claudeBin} auth logout` : `${config.codexBin} logout`;
      process.stdout.write(`tokenshrink does not hold that sign in. Sign out in the official CLI with: ${cmd}\n`);
      return;
    }
    if (!oauthCfg.tokenUrl || !oauthCfg.clientId) {
      process.stdout.write('no OAuth connection is configured, nothing to sign out\n');
      return;
    }
    const removed = oauth.logout(oauthCfg);
    process.stdout.write(removed ? 'OAuth token removed from the cache\n' : 'no cached OAuth token\n');
    return;
  }
  if (sub === 'status') {
    const env = process.env;
    const keyEnvs = [...new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', env.TOKENSHRINK_API_KEY_ENV].filter(Boolean))];
    const apiKeys = keyEnvs.map((name) => ({ env: name, present: Boolean(env[name]) }));
    const oauthConfigured = Boolean(oauthCfg.tokenUrl && oauthCfg.clientId);
    const oauthStatus = oauthConfigured ? oauth.status(oauthCfg) : { loggedIn: false };
    const [claude, codex] = await Promise.all([
      subscription.subscriptionStatus('claude', config.claudeBin),
      subscription.subscriptionStatus('chatgpt', config.codexBin),
    ]);
    const report = {
      apiKeys,
      oauth: { configured: oauthConfigured, grant: oauthCfg.grant ?? null, ...oauthStatus },
      claudeCli: claude,
      codexCli: codex,
    };
    if (values.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    const yes = (b) => (b ? 'ready' : 'not ready');
    const lines = [];
    for (const k of apiKeys) lines.push(`api-key  ${k.env} ${k.present ? 'present' : 'not set'}`);
    if (!oauthConfigured) lines.push('oauth    not configured');
    else if (!oauthStatus.loggedIn) lines.push(`oauth    configured (${oauthCfg.grant ?? 'no grant'}), not signed in, run tokenshrink auth login`);
    else lines.push(`oauth    ${oauthStatus.valid ? 'ready' : 'expired'}, ${oauthStatus.grant}, valid until ${oauthStatus.expiresAt}${oauthStatus.hasRefreshToken ? ', refresh token cached' : ''}`);
    lines.push(`claude   ${claude.installed ? `${yes(claude.signedIn)}, ${claude.signedIn ? 'signed in' : 'run tokenshrink auth login claude'}` : 'claude CLI not installed'}`);
    lines.push(`chatgpt  ${codex.installed ? `${yes(codex.signedIn)}, ${codex.signedIn ? 'signed in' : 'run tokenshrink auth login chatgpt'}` : 'codex CLI not installed'}`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }
  fail(EXIT.usage, 'auth needs login, status or logout');
}

function help() {
  process.stdout.write(HELP);
}

main().catch((err) => fail(EXIT.error, err.message));
