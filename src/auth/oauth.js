// Generic OAuth 2.0 client with three grants. Client credentials (RFC 6749 section 4.4),
// authorization code with PKCE S256 and a loopback redirect (RFC 7636, RFC 8252), and the
// device authorization grant (RFC 8628). Token responses are validated by hand before use.
// Token values are never printed or logged.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { requestJson, HttpError } from '../provider/http.js';
import { openBrowser } from './browser.js';
import { cacheKey, createTokenCache } from './token-cache.js';

export const GRANTS = ['client_credentials', 'pkce', 'device'];
const REFRESH_MARGIN_MS = 60000;

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair(random = randomBytes) {
  const verifier = b64url(random(32));
  const challenge = b64url(createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge, method: 'S256' };
}

export function validateOAuthConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return ['oauth config is missing'];
  if (!GRANTS.includes(cfg.grant)) errors.push(`grant must be one of ${GRANTS.join(', ')}`);
  if (!isHttpUrl(cfg.tokenUrl)) errors.push('tokenUrl must be an http or https URL');
  if (typeof cfg.clientId !== 'string' || cfg.clientId === '') errors.push('clientId is required');
  if (cfg.grant === 'pkce' && !isHttpUrl(cfg.authUrl)) errors.push('authUrl is required for the pkce grant');
  if (cfg.grant === 'device' && !isHttpUrl(cfg.deviceUrl)) errors.push('deviceUrl is required for the device grant');
  if (cfg.grant === 'client_credentials' && !cfg.clientSecret) errors.push('client credentials need a client secret from env');
  if (cfg.clientAuth && !['post', 'basic'].includes(cfg.clientAuth)) errors.push('clientAuth must be post or basic');
  return errors;
}

function isHttpUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:';
  } catch {
    return false;
  }
}

// Hand written schema check for a token endpoint response.
export function validateTokenResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'token response is not a JSON object';
  if (typeof body.access_token !== 'string' || body.access_token === '') return 'token response has no access_token';
  if (body.token_type !== undefined && (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer')) {
    return 'token_type is not bearer';
  }
  if (body.expires_in !== undefined && !Number.isFinite(Number(body.expires_in))) return 'expires_in is not a number';
  if (body.refresh_token !== undefined && typeof body.refresh_token !== 'string') return 'refresh_token is not a string';
  return null;
}

function toEntry(cfg, body, now, previous) {
  const expiresIn = body.expires_in === undefined ? 3600 : Number(body.expires_in);
  return {
    grant: cfg.grant,
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? previous?.refresh_token ?? null,
    expires_at: now + expiresIn * 1000,
    scope: body.scope ?? cfg.scope ?? null,
    obtained_at: now,
  };
}

async function tokenRequest(cfg, params, opts) {
  const form = new URLSearchParams(params);
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (cfg.clientSecret && cfg.clientAuth === 'basic') {
    const enc = (s) => encodeURIComponent(s);
    headers.authorization = `Basic ${Buffer.from(`${enc(cfg.clientId)}:${enc(cfg.clientSecret)}`).toString('base64')}`;
  } else {
    form.set('client_id', cfg.clientId);
    if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret);
  }
  const res = await requestJson(
    cfg.tokenUrl,
    { method: 'POST', headers, body: form.toString() },
    { timeoutMs: opts.timeoutMs ?? 30000, retries: opts.retries ?? 2, fetch: opts.fetch, sleep: opts.sleep, noRetryStatus: [400, 401] },
  );
  const problem = validateTokenResponse(res.body);
  if (problem) throw new AuthError('BAD_TOKEN_RESPONSE', problem);
  return res.body;
}

export async function clientCredentials(cfg, opts = {}) {
  const params = { grant_type: 'client_credentials' };
  if (cfg.scope) params.scope = cfg.scope;
  if (cfg.audience) params.audience = cfg.audience;
  return tokenRequest(cfg, params, opts);
}

export async function refresh(cfg, refreshToken, opts = {}) {
  const params = { grant_type: 'refresh_token', refresh_token: refreshToken };
  if (cfg.scope) params.scope = cfg.scope;
  return tokenRequest(cfg, params, opts);
}

// Authorization code with PKCE. Listens once on 127.0.0.1 with a random port.
export async function authorizationCodePkce(cfg, opts = {}) {
  const pkce = opts.pkce ?? pkcePair();
  const state = opts.state ?? b64url(randomBytes(16));
  const print = opts.print ?? ((s) => process.stderr.write(`${s}\n`));
  const timeoutMs = opts.timeoutMs ?? 300000;

  const { server, port } = await listenLoopback(opts.port ?? 0);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const url = new URL(cfg.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  if (cfg.scope) url.searchParams.set('scope', cfg.scope);
  if (cfg.audience) url.searchParams.set('audience', cfg.audience);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  const callback = waitForCallback(server, state, timeoutMs);
  print(`Open this URL to sign in:\n${url.href}`);
  if (opts.openBrowser !== false) (opts.open ?? openBrowser)(url.href);
  if (opts.onUrl) opts.onUrl(url.href, redirectUri);
  let code;
  try {
    code = await callback;
  } finally {
    server.close();
  }
  return tokenRequest(
    cfg,
    { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: pkce.verifier },
    opts,
  );
}

function listenLoopback(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function waitForCallback(server, expectedState, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AuthError('TIMEOUT', 'no sign in callback within the time limit')), timeoutMs);
    server.on('request', (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      const done = (status, text) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(text);
      const state = u.searchParams.get('state');
      if (state !== expectedState) {
        done(400, 'State mismatch. Sign in was not completed.');
        clearTimeout(timer);
        reject(new AuthError('STATE_MISMATCH', 'state in the callback does not match, possible forged request'));
        return;
      }
      const error = u.searchParams.get('error');
      if (error) {
        done(400, 'Sign in failed. You can close this window.');
        clearTimeout(timer);
        reject(new AuthError('AUTH_DENIED', `authorization server returned ${error.slice(0, 100)}`));
        return;
      }
      const code = u.searchParams.get('code');
      if (!code) {
        done(400, 'No code in the callback.');
        clearTimeout(timer);
        reject(new AuthError('NO_CODE', 'callback had no code'));
        return;
      }
      done(200, 'Signed in. You can close this window and return to the terminal.');
      clearTimeout(timer);
      resolve(code);
    });
  });
}

// Device authorization grant. Prints the code and URL, then polls at the server interval.
export async function deviceAuthorization(cfg, opts = {}) {
  const print = opts.print ?? ((s) => process.stderr.write(`${s}\n`));
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const form = new URLSearchParams({ client_id: cfg.clientId });
  if (cfg.scope) form.set('scope', cfg.scope);
  if (cfg.audience) form.set('audience', cfg.audience);
  const res = await requestJson(
    cfg.deviceUrl,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() },
    { timeoutMs: opts.timeoutMs ?? 30000, retries: 2, fetch: opts.fetch, sleep: opts.sleep },
  );
  const d = res.body;
  if (!d || typeof d.device_code !== 'string' || typeof d.user_code !== 'string' || typeof (d.verification_uri ?? d.verification_url) !== 'string') {
    throw new AuthError('BAD_DEVICE_RESPONSE', 'device authorization response is missing device_code, user_code or verification_uri');
  }
  const verification = d.verification_uri ?? d.verification_url;
  print(`To sign in, open ${verification} and enter the code ${d.user_code}`);
  if (typeof d.verification_uri_complete === 'string') print(`Or open ${d.verification_uri_complete}`);
  let interval = Math.max(1, Number(d.interval) || 5) * 1000;
  const deadline = now() + Math.max(30, Number(d.expires_in) || 900) * 1000;
  while (now() < deadline) {
    await sleep(interval);
    try {
      return await tokenRequest(
        cfg,
        { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code },
        { ...opts, retries: 0 },
      );
    } catch (err) {
      const code = err instanceof HttpError && err.body && typeof err.body === 'object' ? err.body.error : null;
      if (code === 'authorization_pending') continue;
      if (code === 'slow_down') {
        interval += 5000;
        continue;
      }
      if (code === 'access_denied') throw new AuthError('AUTH_DENIED', 'sign in was denied');
      if (code === 'expired_token') throw new AuthError('EXPIRED', 'the device code expired, run auth login again');
      throw err;
    }
  }
  throw new AuthError('EXPIRED', 'the device code expired, run auth login again');
}

export async function login(cfg, opts = {}) {
  const errors = validateOAuthConfig(cfg);
  if (errors.length) throw new AuthError('BAD_CONFIG', errors.join('; '));
  const cache = opts.cache ?? createTokenCache();
  const now = opts.now ?? Date.now;
  let body;
  if (cfg.grant === 'client_credentials') body = await clientCredentials(cfg, opts);
  else if (cfg.grant === 'pkce') body = await authorizationCodePkce(cfg, opts);
  else body = await deviceAuthorization(cfg, opts);
  const entry = toEntry(cfg, body, now());
  cache.set(cacheKey(cfg), entry);
  return describeEntry(entry, now());
}

// Return a valid access token, refreshing before expiry. Interactive grants are never started
// here, only by auth login.
export async function getAccessToken(cfg, opts = {}) {
  const errors = validateOAuthConfig(cfg);
  if (errors.length) throw new AuthError('BAD_CONFIG', errors.join('; '));
  const cache = opts.cache ?? createTokenCache();
  const now = opts.now ?? Date.now;
  const key = cacheKey(cfg);
  const entry = cache.get(key);
  if (entry && typeof entry.access_token === 'string' && entry.expires_at - REFRESH_MARGIN_MS > now()) return entry.access_token;
  if (entry?.refresh_token) {
    try {
      const body = await refresh(cfg, entry.refresh_token, opts);
      const next = toEntry(cfg, body, now(), entry);
      cache.set(key, next);
      return next.access_token;
    } catch (err) {
      if (err instanceof HttpError && err.status && err.status < 500) cache.delete(key);
      else throw err;
    }
  }
  if (cfg.grant === 'client_credentials') {
    const body = await clientCredentials(cfg, opts);
    const next = toEntry(cfg, body, now());
    cache.set(key, next);
    return next.access_token;
  }
  throw new AuthError('LOGIN_REQUIRED', 'no valid OAuth token, run: tokenshrink auth login');
}

export function status(cfg, opts = {}) {
  const cache = opts.cache ?? createTokenCache();
  const now = (opts.now ?? Date.now)();
  const entry = cfg && cfg.tokenUrl && cfg.clientId ? cache.get(cacheKey(cfg)) : null;
  if (!entry) return { loggedIn: false };
  return describeEntry(entry, now);
}

function describeEntry(entry, now) {
  return {
    loggedIn: true,
    grant: entry.grant,
    valid: entry.expires_at > now,
    expiresAt: new Date(entry.expires_at).toISOString(),
    hasRefreshToken: Boolean(entry.refresh_token),
    scope: entry.scope,
  };
}

export function logout(cfg, opts = {}) {
  const cache = opts.cache ?? createTokenCache();
  return cache.delete(cacheKey(cfg));
}
