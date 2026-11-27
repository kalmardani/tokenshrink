// HTTP helper for provider and token calls. Timeout on every call, bounded retries with
// exponential backoff and jitter on 429, 5xx and network errors, Retry-After honoured up to a
// cap. Error messages never include request headers, so keys and tokens cannot leak there.

export class HttpError extends Error {
  constructor(message, { status, body, retryable } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export async function requestJson(url, init = {}, opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? sleepReal;
  const random = opts.random ?? Math.random;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      lastError = new HttpError(timedOut ? `request timed out after ${timeoutMs} ms` : `network error: ${err?.message ?? err}`, {
        retryable: true,
      });
      if (attempt < retries) {
        await sleep(backoff(attempt, null, random));
        continue;
      }
      throw lastError;
    }
    const text = await res.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (res.ok) return { status: res.status, body, headers: res.headers };
    const retryable = res.status === 429 || res.status >= 500;
    lastError = new HttpError(`HTTP ${res.status} from ${safeOrigin(url)}: ${summarize(body)}`, {
      status: res.status,
      body,
      retryable,
    });
    if (retryable && attempt < retries && !opts.noRetryStatus?.includes(res.status)) {
      await sleep(backoff(attempt, res.headers.get('retry-after'), random));
      continue;
    }
    throw lastError;
  }
  throw lastError;
}

export function backoff(attempt, retryAfter, random = Math.random) {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30000);
  }
  const base = 500 * 2 ** attempt;
  return Math.min(base + Math.floor(random() * base * 0.5), 20000);
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return 'endpoint';
  }
}

function summarize(body) {
  if (body === null || body === undefined) return 'empty body';
  if (typeof body === 'string') return redact(body.slice(0, 300));
  const msg = body.error?.message ?? body.error_description ?? body.error ?? body.message;
  return redact(typeof msg === 'string' ? msg.slice(0, 300) : JSON.stringify(body).slice(0, 300));
}

// Remove anything that looks like a bearer token or key from text that may be printed.
export function redact(s) {
  return String(s)
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '$1-[redacted]')
    .replace(/("?(?:access_token|refresh_token|id_token|api_key|client_secret)"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[redacted]');
}
