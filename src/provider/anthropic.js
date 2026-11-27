// Adapter for the Anthropic Messages API. An API key goes in x-api-key. An OAuth token is sent
// as a bearer token, which is meant for gateways in front of the API that accept it.

import { ConfigError } from '../config.js';
import { requestJson } from './http.js';

export async function completeAnthropic(req, { config, deps, credentials }) {
  if (!config.model) throw new ConfigError('the anthropic provider needs a model, set TOKENSHRINK_MODEL or --model');
  const base = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const cred = await credentials();
  if (cred.kind === 'none') throw new ConfigError(`no credentials for the anthropic provider, set ${cred.missing ?? 'ANTHROPIC_API_KEY'}`);
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (cred.kind === 'api-key') headers['x-api-key'] = cred.value;
  else headers.authorization = `Bearer ${cred.value}`;
  const body = { model: config.model, max_tokens: req.maxTokens ?? 512, messages: req.messages };
  if (req.system) body.system = req.system;
  if (config.temperature !== null && config.temperature !== undefined) body.temperature = config.temperature;
  const started = Date.now();
  const res = await requestJson(
    `${base}/v1/messages`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    { timeoutMs: config.timeoutMs, retries: 3, fetch: deps.fetch, sleep: deps.sleep },
  );
  const b = res.body ?? {};
  if (!Array.isArray(b.content)) throw new Error('anthropic response has no content array');
  const text = b.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  return {
    text,
    model: typeof b.model === 'string' ? b.model : config.model,
    usage: { inputTokens: b.usage?.input_tokens ?? null, outputTokens: b.usage?.output_tokens ?? null },
    latencyMs: Date.now() - started,
    costUsd: null,
  };
}
