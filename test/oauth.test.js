import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { pkcePair, login, getAccessToken, status, logout, validateTokenResponse, authorizationCodePkce } from '../src/auth/oauth.js';
import { createTokenCache, cacheKey } from '../src/auth/token-cache.js';
import { configDir } from '../src/auth/paths.js';
import { tempDir } from './helpers.js';

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Local fake authorization server. No network beyond 127.0.0.1.
async function fakeAuthServer(t, opts = {}) {
  const state = { codes: new Map(), tokenCalls: [], deviceStep: 0, refreshCount: 0, issued: 0 };
  const issue = (res, extra = {}) => {
    state.issued++;
    json(res, 200, { access_token: `at-${state.issued}`, token_type: 'Bearer', expires_in: opts.expiresIn ?? 3600, refresh_token: `rt-${state.issued}`, ...extra });
  };
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const p = Object.fromEntries(new URLSearchParams(raw));
      if (req.url === '/token') {
        state.tokenCalls.push({ ...p, authorization: req.headers.authorization });
        if (p.grant_type === 'client_credentials') {
          const basic = req.headers.authorization ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString() : null;
          const ok = (p.client_id === 'cid' && p.client_secret === 'shh') || basic === 'cid:shh';
          return ok ? issue(res) : json(res, 401, { error: 'invalid_client' });
        }
        if (p.grant_type === 'authorization_code') {
          const entry = state.codes.get(p.code);
          if (!entry) return json(res, 400, { error: 'invalid_grant' });
          const challenge = b64url(createHash('sha256').update(p.code_verifier ?? '').digest());
          if (challenge !== entry.challenge || p.redirect_uri !== entry.redirect) return json(res, 400, { error: 'invalid_grant', error_description: 'pkce mismatch' });
          state.codes.delete(p.code);
          return issue(res);
        }
        if (p.grant_type === 'refresh_token') {
          state.refreshCount++;
          if (opts.refreshFails) return json(res, 400, { error: 'invalid_grant' });
          return issue(res, opts.rotate === false ? { refresh_token: undefined } : {});
        }
        if (p.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
          state.deviceStep++;
          const script = opts.deviceScript ?? ['authorization_pending', 'slow_down', 'authorization_pending', 'ok'];
          const step = script[Math.min(state.deviceStep - 1, script.length - 1)];
          if (step === 'ok') return issue(res);
          return json(res, 400, { error: step });
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      if (req.url === '/device') {
        return json(res, 200, { device_code: 'dc-1', user_code: 'ABCD-EFGH', verification_uri: 'http://127.0.0.1/activate', expires_in: 600, interval: 2 });
      }
      json(res, 404, { error: 'not_found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, state };
}

test('PKCE pair matches the RFC 7636 example', () => {
  const octets = Buffer.from([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]);
  const p = pkcePair(() => octets);
  assert.equal(p.verifier, 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(p.challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const random = pkcePair();
  assert.match(random.verifier, /^[A-Za-z0-9_-]{43}$/);
});

test('token response schema check', () => {
  assert.equal(validateTokenResponse({ access_token: 'a', token_type: 'Bearer', expires_in: 10 }), null);
  assert.match(validateTokenResponse({ token_type: 'Bearer' }), /access_token/);
  assert.match(validateTokenResponse({ access_token: 'a', token_type: 'mac' }), /bearer/);
  assert.match(validateTokenResponse([]), /object/);
});

test('client credentials with post and basic client auth, token cached with mode 0600', async (t) => {
  const { base, state } = await fakeAuthServer(t);
  const dir = tempDir(t);
  const cache = createTokenCache({ dir });
  for (const clientAuth of ['post', 'basic']) {
    const cfg = { grant: 'client_credentials', tokenUrl: `${base}/token`, clientId: 'cid', clientSecret: 'shh', scope: `api.${clientAuth}`, clientAuth };
    const s = await login(cfg, { cache });
    assert.equal(s.loggedIn, true);
    assert.equal(s.valid, true);
    assert.equal(JSON.stringify(s).includes('at-'), false, 'status never shows the token');
    assert.match(await getAccessToken(cfg, { cache }), /^at-\d$/);
  }
  assert.equal(state.tokenCalls[1].authorization.startsWith('Basic '), true);
  assert.equal(state.tokenCalls[1].client_secret, undefined);
  if (process.platform !== 'win32') assert.equal(statSync(cache.file).mode & 0o777, 0o600);
  const bad = { grant: 'client_credentials', tokenUrl: `${base}/token`, clientId: 'cid', clientSecret: 'wrong' };
  await assert.rejects(login(bad, { cache }), /HTTP 401/);
});

test('expiry triggers refresh before use, and a failed refresh asks for login', async (t) => {
  const { base, state } = await fakeAuthServer(t, { expiresIn: 120 });
  const cache = createTokenCache({ dir: tempDir(t) });
  const cfg = { grant: 'pkce', tokenUrl: `${base}/token`, authUrl: `${base}/authorize`, clientId: 'cid' };
  let now = 1_000_000;
  cache.set(cacheKey(cfg), { grant: 'pkce', access_token: 'old', refresh_token: 'rt-0', expires_at: now + 120_000, obtained_at: now });
  assert.equal(await getAccessToken(cfg, { cache, now: () => now }), 'old');
  now += 90_000; // inside the 60 second refresh margin
  const fresh = await getAccessToken(cfg, { cache, now: () => now });
  assert.equal(fresh, 'at-1');
  assert.equal(state.refreshCount, 1);
  assert.equal(cache.get(cacheKey(cfg)).refresh_token, 'rt-1');
  assert.equal(status(cfg, { cache, now: () => now }).valid, true);
  assert.equal(status(cfg, { cache, now: () => now + 10_000_000 }).valid, false);

  const failing = await fakeAuthServer(t, { refreshFails: true });
  const cfg2 = { ...cfg, tokenUrl: `${failing.base}/token` };
  cache.set(cacheKey(cfg2), { grant: 'pkce', access_token: 'old', refresh_token: 'rt-x', expires_at: 0, obtained_at: 0 });
  await assert.rejects(getAccessToken(cfg2, { cache }), { code: 'LOGIN_REQUIRED' });
  assert.equal(cache.get(cacheKey(cfg2)), null);
  assert.equal(logout(cfg, { cache }), true);
  assert.equal(status(cfg, { cache }).loggedIn, false);
});

test('authorization code with PKCE over a loopback redirect, state checked', async (t) => {
  const { base, state } = await fakeAuthServer(t);
  const cache = createTokenCache({ dir: tempDir(t) });
  const cfg = { grant: 'pkce', tokenUrl: `${base}/token`, authUrl: `${base}/authorize`, clientId: 'cid', scope: 'openid' };
  const s = await login(cfg, {
    cache,
    openBrowser: false,
    print: () => {},
    onUrl: (href, redirect) => {
      const u = new URL(href);
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(u.searchParams.get('redirect_uri'), redirect);
      assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      state.codes.set('code-1', { challenge: u.searchParams.get('code_challenge'), redirect });
      // Play the browser, follow the redirect with the right state.
      fetch(`${redirect}?code=code-1&state=${u.searchParams.get('state')}`);
    },
  });
  assert.equal(s.loggedIn, true);
  assert.equal(s.hasRefreshToken, true);

  // A callback with a wrong state is rejected and no token is requested.
  const calls = state.tokenCalls.length;
  await assert.rejects(
    authorizationCodePkce(cfg, {
      openBrowser: false,
      print: () => {},
      onUrl: (href, redirect) => {
        fetch(`${redirect}?code=code-2&state=forged`).catch(() => {});
      },
    }),
    { code: 'STATE_MISMATCH' },
  );
  assert.equal(state.tokenCalls.length, calls);

  // An error from the authorization server is reported.
  await assert.rejects(
    authorizationCodePkce(cfg, {
      openBrowser: false,
      print: () => {},
      onUrl: (href, redirect) => {
        fetch(`${redirect}?error=access_denied&state=${new URL(href).searchParams.get('state')}`).catch(() => {});
      },
    }),
    { code: 'AUTH_DENIED' },
  );
});

test('device grant polls with authorization_pending and slows down on slow_down', async (t) => {
  const { base, state } = await fakeAuthServer(t);
  const cache = createTokenCache({ dir: tempDir(t) });
  const cfg = { grant: 'device', tokenUrl: `${base}/token`, deviceUrl: `${base}/device`, clientId: 'cid', scope: 'api' };
  const waits = [];
  const printed = [];
  const s = await login(cfg, { cache, sleep: async (ms) => waits.push(ms), print: (l) => printed.push(l) });
  assert.equal(s.loggedIn, true);
  assert.deepEqual(waits, [2000, 2000, 7000, 7000]);
  assert.equal(state.deviceStep, 4);
  assert.match(printed.join('\n'), /ABCD-EFGH/);
  const denied = await fakeAuthServer(t, { deviceScript: ['authorization_pending', 'access_denied'] });
  await assert.rejects(login({ ...cfg, tokenUrl: `${denied.base}/token`, deviceUrl: `${denied.base}/device` }, { cache, sleep: async () => {}, print: () => {} }), {
    code: 'AUTH_DENIED',
  });
});

test('config validation and config dir per platform', () => {
  assert.match(configDir({}, 'win32'), /tokenshrink$/);
  assert.equal(configDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32').includes('Roaming'), true);
  assert.equal(configDir({ XDG_CONFIG_HOME: '/x/cfg' }, 'linux').startsWith('/x/cfg'), true);
  assert.match(configDir({}, 'darwin'), /Library.Application Support.tokenshrink$/);
  return assert.rejects(login({ grant: 'device', tokenUrl: 'ftp://x', clientId: '' }, {}), { code: 'BAD_CONFIG' });
});

test('the token cache file never ends up in logs or status output', async (t) => {
  const dir = tempDir(t);
  const cache = createTokenCache({ dir });
  cache.set('k', { access_token: 'secret-token-value', expires_at: Date.now() + 1e6 });
  assert.ok(readFileSync(cache.file, 'utf8').includes('secret-token-value'));
  const s = status({ tokenUrl: 'http://x/token', clientId: 'c' }, { cache });
  assert.equal(JSON.stringify(s).includes('secret'), false);
});
