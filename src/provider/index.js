// Provider layer. One function, complete(), hides which model service answers. Every adapter
// returns { text, model, usage: { inputTokens, outputTokens }, latencyMs, costUsd }.
//
// Adapters  openai, anthropic, claude-cli, codex-cli, fake
// Auth      api-key, oauth, subscription (the two CLIs only), none

import { getAccessToken } from '../auth/oauth.js';
import { ConfigError } from '../config.js';
import { completeOpenAI } from './openai.js';
import { completeAnthropic } from './anthropic.js';
import { completeClaudeCli } from './claude-cli.js';
import { completeCodexCli } from './codex-cli.js';
import { createFakeProvider } from './fake.js';

export { createFakeProvider };

export function createProvider(config, deps = {}) {
  if (config.provider === 'fake') return deps.fake ?? createFakeProvider();
  const credentials = () => resolveCredentials(config, deps);
  const common = { config, deps, credentials };
  switch (config.provider) {
    case 'openai':
      return { name: 'openai', model: config.model, complete: (req) => completeOpenAI(req, common) };
    case 'anthropic':
      return { name: 'anthropic', model: config.model, complete: (req) => completeAnthropic(req, common) };
    case 'claude-cli':
      return { name: 'claude-cli', model: config.model, complete: (req) => completeClaudeCli(req, common) };
    case 'codex-cli':
      return { name: 'codex-cli', model: config.model, complete: (req) => completeCodexCli(req, common) };
    default:
      throw new ConfigError(`unknown provider ${config.provider}`);
  }
}

// Returns { kind: 'api-key' | 'bearer' | 'none', value }. The value never leaves this process
// except in the request header to the configured endpoint.
export async function resolveCredentials(config, deps = {}) {
  const auth = config.auth;
  if (auth.type === 'none') return { kind: 'none' };
  if (auth.type === 'api-key') {
    const value = config.env[auth.keyEnv];
    if (!value) return { kind: 'none', missing: auth.keyEnv };
    return { kind: 'api-key', value };
  }
  if (auth.type === 'oauth') {
    const token = await getAccessToken(auth.oauth, { cache: deps.tokenCache, fetch: deps.fetch, now: deps.now });
    return { kind: 'bearer', value: token };
  }
  return { kind: 'none' };
}
