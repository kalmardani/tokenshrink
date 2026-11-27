// Local HTTP proxy in front of an OpenAI compatible chat completions endpoint. Oversized
// message contents are compressed before the request is forwarded. The client's auth header is
// forwarded untouched and never stored or logged. The upstream answer, streaming or not, is
// piped back byte for byte.

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { compress } from './compress.js';
import { estimateTokens } from './tokens.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopback(host) {
  return LOOPBACK.has(String(host).toLowerCase());
}

// opts.upstream    base URL, for example https://api.openai.com
// opts.store       store for originals, or null
// opts.threshold   estimated tokens above which a content part is compressed (default 1000)
// opts.roles       roles whose content may be compressed (default tool, function, user)
// opts.budget      optional token budget per content part
// opts.level       compression level
// opts.maxBodyBytes request body limit (default 32 MB)
// opts.timeoutMs   upstream idle timeout (default 600000)
// opts.allowOrigins origins allowed to call the proxy from a browser (default none)
// opts.checkHost   reject non loopback Host headers (default true)
// opts.log         function for one line per request (no content, no headers)
export function createProxy(opts) {
  const upstream = new URL(opts.upstream);
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') throw new Error('upstream must be an http or https URL');
  const prefix = upstream.pathname.replace(/\/+$/, '');
  const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  const threshold = opts.threshold ?? 1000;
  const roles = new Set(opts.roles ?? ['tool', 'function', 'user']);
  const maxBody = opts.maxBodyBytes ?? 32 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 600000;
  const allowOrigins = new Set(opts.allowOrigins ?? []);
  const checkHost = opts.checkHost !== false;
  const log = opts.log ?? (() => {});

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`proxy error ${err.message}`);
      if (!res.headersSent) jsonError(res, 502, 'tokenshrink proxy failed to forward the request');
      else res.destroy();
    });
  });

  async function handle(req, res) {
    const hostHeader = String(req.headers.host ?? '').replace(/:\d+$/, '');
    if (checkHost && !isLoopback(hostHeader)) {
      jsonError(res, 421, 'tokenshrink proxy accepts only loopback Host headers');
      return;
    }
    const origin = req.headers.origin;
    if (origin && !allowOrigins.has(origin)) {
      jsonError(res, 403, 'tokenshrink proxy does not accept browser requests from this origin');
      return;
    }
    let body = await readBody(req, maxBody);
    if (body === null) {
      jsonError(res, 413, `request body larger than ${maxBody} bytes`);
      return;
    }
    const path = req.url ?? '/';
    let note = 'passed through';
    const encoding = String(req.headers['content-encoding'] ?? 'identity').toLowerCase();
    if (req.method === 'POST' && /\/chat\/completions(?:\?|$)/.test(path) && encoding === 'identity' && body.length > 0) {
      const result = rewrite(body);
      if (result) {
        body = result.body;
        note = `compressed ${result.parts} parts, ${result.before} to ${result.after} tokens est.`;
      } else note = 'nothing to compress';
    }
    log(`${req.method} ${path.split('?')[0]} ${note}`);
    forward(req, res, path, body);
  }

  function rewrite(raw) {
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
    if (!payload || !Array.isArray(payload.messages)) return null;
    let parts = 0;
    let before = 0;
    let after = 0;
    const shrink = (text) => {
      if (typeof text !== 'string' || estimateTokens(text) <= threshold) return text;
      const r = compress(text, { store: opts.store ?? null, budget: opts.budget, level: opts.level, source: 'proxy' });
      if (!r.compressed) return text;
      parts++;
      before += r.originalTokens;
      after += r.tokens;
      return r.text;
    };
    for (const m of payload.messages) {
      if (!m || typeof m !== 'object' || !roles.has(m.role)) continue;
      if (typeof m.content === 'string') m.content = shrink(m.content);
      else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') part.text = shrink(part.text);
        }
      }
    }
    if (parts === 0) return null;
    return { body: Buffer.from(JSON.stringify(payload), 'utf8'), parts, before, after };
  }

  function forward(req, res, path, body) {
    const headers = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      if (HOP_BY_HOP.has(name.toLowerCase())) continue;
      // Repeated headers keep every value. Authorization is copied as is.
      headers[name] = headers[name] === undefined ? req.rawHeaders[i + 1] : [].concat(headers[name], req.rawHeaders[i + 1]);
    }
    headers.host = upstream.host;
    headers['content-length'] = String(body.length);
    const up = send(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || undefined,
        method: req.method,
        path: prefix + path,
        headers,
      },
      (upRes) => {
        const out = [];
        for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
          const name = upRes.rawHeaders[i].toLowerCase();
          if (name === 'transfer-encoding' || name === 'connection' || name === 'keep-alive') continue;
          out.push(upRes.rawHeaders[i], upRes.rawHeaders[i + 1]);
        }
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, out);
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
      },
    );
    up.setTimeout(timeoutMs, () => up.destroy(new Error('upstream timeout')));
    up.on('error', (err) => {
      log(`upstream error ${err.message}`);
      if (!res.headersSent) jsonError(res, err.message === 'upstream timeout' ? 504 : 502, 'tokenshrink proxy could not reach the upstream');
      else res.destroy();
    });
    res.on('close', () => {
      if (!res.writableFinished) up.destroy();
    });
    up.end(body);
  }

  return server;
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonError(res, status, message) {
  const body = JSON.stringify({ error: { message, type: 'tokenshrink_proxy_error' } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
