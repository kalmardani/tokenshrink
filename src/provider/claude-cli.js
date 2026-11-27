// Adapter for the official claude CLI in print mode. It runs with the user's own sign in, which
// the CLI manages itself. tokenshrink never reads or reuses the tokens the CLI stores.
// The model gets no tools, no MCP servers and no session persistence, so text it reads cannot
// make it act.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { looksTransient, flattenMessages, makeWorkDir, removeWorkDir, runProcess } from './subprocess.js';
import { backoff } from './http.js';

// The system prompt goes through a file, never as an argument, so multi line text with quotes
// survives every platform, cmd.exe shims included.
export function claudeArgs({ systemFile, model }) {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    '--disable-slash-commands',
  ];
  if (systemFile) args.push('--system-prompt-file', systemFile);
  if (model) {
    if (!/^[\w.:@/-]{1,100}$/.test(model)) throw new Error('model name has unexpected characters');
    args.push('--model', model);
  }
  // Last, because --tools takes a list. An empty value means no tools.
  args.push('--tools', '');
  return args;
}

export function parseClaudeOutput(stdout) {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type !== 'result' && typeof obj.result !== 'string') continue;
    const u = obj.usage ?? {};
    const input = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].reduce((a, b) => a + (Number(b) || 0), 0);
    const models = obj.modelUsage && typeof obj.modelUsage === 'object' ? Object.keys(obj.modelUsage) : [];
    return {
      isError: Boolean(obj.is_error),
      text: typeof obj.result === 'string' ? obj.result : '',
      model: models[0] ?? null,
      usage: { inputTokens: input || null, outputTokens: Number(u.output_tokens) || null },
      costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
    };
  }
  throw new Error('claude CLI output had no result object');
}

export function writeSystemFile(dir, system) {
  if (!system) return null;
  const file = join(dir, 'system-prompt.txt');
  writeFileSync(file, system, 'utf8');
  return file;
}

export async function completeClaudeCli(req, { config, deps }) {
  const prompt = flattenMessages(req.messages);
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last;
  for (let attempt = 0; attempt <= 2; attempt++) {
    const dir = makeWorkDir();
    const started = Date.now();
    try {
      const args = claudeArgs({ systemFile: writeSystemFile(dir, req.system), model: config.model });
      const r = await runProcess(config.claudeBin, args, { input: prompt, cwd: dir, timeoutMs: config.timeoutMs, spawnImpl: deps.spawn });
      if (r.code === 0) {
        const out = parseClaudeOutput(r.stdout);
        if (!out.isError) return { ...out, model: out.model ?? config.model ?? 'claude-cli default', latencyMs: Date.now() - started };
        last = new Error(`claude CLI reported an error: ${out.text.slice(0, 200)}`);
        if (!looksTransient(out.text)) throw last;
      } else {
        last = new Error(`claude CLI exited with code ${r.code}: ${r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300)}`);
        if (!looksTransient(r.stderr + r.stdout)) throw last;
      }
    } finally {
      removeWorkDir(dir);
    }
    if (attempt < 2) await sleep(backoff(attempt, null));
  }
  throw last;
}
