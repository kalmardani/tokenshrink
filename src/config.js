// Configuration. Precedence is CLI flag, then env var, then the JSON config file, then
// defaults. Secrets come only from env vars. A config file that holds a secret is rejected.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './auth/paths.js';

export const PROVIDERS = ['openai', 'anthropic', 'claude-cli', 'codex-cli', 'fake'];
export const AUTH_TYPES = ['api-key', 'oauth', 'subscription', 'none'];

const SECRET_FIELDS = ['apiKey', 'api_key', 'clientSecret', 'client_secret', 'token', 'accessToken', 'refreshToken', 'password'];

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function configFilePath(env = process.env, flag) {
  if (flag) return flag;
  if (env.TOKENSHRINK_CONFIG) return env.TOKENSHRINK_CONFIG;
  return join(configDir(env), 'config.json');
}

export function readConfigFile(path, { required = false } = {}) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (required) throw new ConfigError(`cannot read config file ${path}: ${err.code ?? err.message}`);
    return {};
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config file ${path} is not valid JSON: ${err.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConfigError(`config file ${path} must hold a JSON object`);
  const found = findSecrets(data);
  if (found.length) {
    throw new ConfigError(`config file ${path} contains ${found.join(', ')}. Secrets belong in env vars, see README`);
  }
  return data;
}

function findSecrets(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_FIELDS.includes(k)) out.push(prefix + k);
    else if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...findSecrets(v, `${prefix}${k}.`));
  }
  return out;
}

// Build the provider config. flags holds --provider, --model, --base-url, --auth, --config.
export function resolveConfig(flags = {}, env = process.env) {
  const file = readConfigFile(configFilePath(env, flags.config), { required: Boolean(flags.config) });
  const fileAuth = file.auth ?? {};
  const fileOAuth = fileAuth.oauth ?? {};
  const provider = flags.provider ?? env.TOKENSHRINK_PROVIDER ?? file.provider ?? 'claude-cli';
  if (!PROVIDERS.includes(provider)) throw new ConfigError(`unknown provider ${provider}, expected one of ${PROVIDERS.join(', ')}`);
  const defaultAuth = provider === 'claude-cli' || provider === 'codex-cli' ? 'subscription' : provider === 'fake' ? 'none' : 'api-key';
  const authType = flags.auth ?? env.TOKENSHRINK_AUTH ?? fileAuth.type ?? defaultAuth;
  if (!AUTH_TYPES.includes(authType)) throw new ConfigError(`unknown auth ${authType}, expected one of ${AUTH_TYPES.join(', ')}`);
  if (authType === 'subscription' && provider !== 'claude-cli' && provider !== 'codex-cli') {
    throw new ConfigError('subscription auth works only through the claude-cli or codex-cli provider');
  }
  if ((provider === 'claude-cli' || provider === 'codex-cli') && authType !== 'subscription') {
    throw new ConfigError(`${provider} signs in through its own CLI, use auth subscription`);
  }
  const defaultKeyEnv = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const keyEnv = env.TOKENSHRINK_API_KEY_ENV ?? fileAuth.apiKeyEnv ?? defaultKeyEnv;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) throw new ConfigError('api key env name must be a plain env var name');
  const secretEnv = fileOAuth.clientSecretEnv;
  const oauth = {
    grant: env.TOKENSHRINK_OAUTH_GRANT ?? fileOAuth.grant,
    tokenUrl: env.TOKENSHRINK_OAUTH_TOKEN_URL ?? fileOAuth.tokenUrl,
    authUrl: env.TOKENSHRINK_OAUTH_AUTH_URL ?? fileOAuth.authUrl,
    deviceUrl: env.TOKENSHRINK_OAUTH_DEVICE_URL ?? fileOAuth.deviceUrl,
    clientId: env.TOKENSHRINK_OAUTH_CLIENT_ID ?? fileOAuth.clientId,
    clientSecret: env.TOKENSHRINK_OAUTH_CLIENT_SECRET ?? (secretEnv ? env[secretEnv] : undefined),
    scope: env.TOKENSHRINK_OAUTH_SCOPE ?? fileOAuth.scope,
    audience: env.TOKENSHRINK_OAUTH_AUDIENCE ?? fileOAuth.audience,
    clientAuth: env.TOKENSHRINK_OAUTH_CLIENT_AUTH ?? fileOAuth.clientAuth ?? 'post',
  };
  const timeoutMs = Number(env.TOKENSHRINK_TIMEOUT_MS ?? file.timeoutMs ?? 120000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new ConfigError('timeout must be at least 1000 ms');
  const temperature = env.TOKENSHRINK_TEMPERATURE ?? file.temperature;
  return {
    provider,
    model: flags.model ?? env.TOKENSHRINK_MODEL ?? file.model ?? null,
    baseUrl: flags.baseUrl ?? env.TOKENSHRINK_BASE_URL ?? file.baseUrl ?? null,
    auth: { type: authType, keyEnv, oauth },
    timeoutMs,
    temperature: temperature === undefined || temperature === '' ? null : Number(temperature),
    claudeBin: env.TOKENSHRINK_CLAUDE_BIN ?? file.claudeBin ?? 'claude',
    codexBin: env.TOKENSHRINK_CODEX_BIN ?? file.codexBin ?? 'codex',
    env,
  };
}
