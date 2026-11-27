// Adapter for any OpenAI compatible chat completions endpoint. Covers hosted services and local
// servers. Base URL, model and auth come from config.

import { ConfigError } from '../config.js';
import { requestJson } from './http.js';

export async function completeOpenAI(req, { config, deps, credentials }) {
  if (!config.model) throw new ConfigError('the openai provider needs a model, set TOKENSHRINK_MODEL or --model');
  const base = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const cred = await credentials();
  const headers = { 'content-type': 'application/json' };
  if (cred.kind === 'api-key' || cred.kind === 'bearer') headers.authorization = `Bearer ${cred.value}`;
  const messages = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push(...req.messages);
  const body = { model: config.model, messages, max_tokens: req.maxTokens ?? 512 };
  if (config.temperature !== null && config.temperature !== undefined) body.temperature = config.temperature;
  const started = Date.now();
  const res = await requestJson(
    `${base}/chat/completions`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    { timeoutMs: config.timeoutMs, retries: 3, fetch: deps.fetch, sleep: deps.sleep },
  );
  const b = res.body ?? {};
  const text = b.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('openai response has no choices[0].message.content');
  return {
    text,
    model: typeof b.model === 'string' ? b.model : config.model,
    usage: { inputTokens: b.usage?.prompt_tokens ?? null, outputTokens: b.usage?.completion_tokens ?? null },
    latencyMs: Date.now() - started,
    costUsd: null,
  };
}
