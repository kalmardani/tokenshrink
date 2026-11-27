// Adapter for the official codex CLI (codex exec). It runs with the user's own sign in, which
// the CLI manages itself. tokenshrink never reads or reuses the tokens the CLI stores.
// Codex is an agent, so it runs with the read-only sandbox, without the user config, in an
// empty temp dir.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { looksTransient, flattenMessages, makeWorkDir, removeWorkDir, runProcess } from './subprocess.js';
import { backoff } from './http.js';

export function codexArgs({ dir, outFile, model }) {
  const args = [
    'exec',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--color',
    'never',
    '--json',
    '-C',
    dir,
    '-o',
    outFile,
  ];
  if (model) {
    if (!/^[\w.:@/-]{1,100}$/.test(model)) throw new Error('model name has unexpected characters');
    args.push('-m', model);
  }
  args.push('-');
  return args;
}

export function parseCodexEvents(stdout) {
  let inputTokens = 0;
  let outputTokens = 0;
  let model = null;
  let lastMessage = null;
  let error = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const u = ev.usage ?? ev.info?.total_token_usage;
    if (u && typeof u === 'object') {
      inputTokens = Math.max(inputTokens, Number(u.input_tokens) || 0);
      outputTokens = Math.max(outputTokens, Number(u.output_tokens) || 0);
    }
    if (typeof ev.model === 'string') model = ev.model;
    const item = ev.item;
    if (item && (item.type === 'agent_message' || item.item_type === 'assistant_message') && typeof item.text === 'string') lastMessage = item.text;
    if (ev.type === 'error' || ev.type === 'turn.failed') error = ev.message ?? ev.error?.message ?? 'codex reported an error';
  }
  return { inputTokens: inputTokens || null, outputTokens: outputTokens || null, model, lastMessage, error };
}

export async function completeCodexCli(req, { config, deps }) {
  const prompt = req.system ? `${req.system}\n\n${flattenMessages(req.messages)}` : flattenMessages(req.messages);
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last;
  for (let attempt = 0; attempt <= 2; attempt++) {
    const dir = makeWorkDir();
    const outFile = join(dir, 'last-message.txt');
    const started = Date.now();
    try {
      const args = codexArgs({ dir, outFile, model: config.model });
      const r = await runProcess(config.codexBin, args, { input: prompt, cwd: dir, timeoutMs: config.timeoutMs, spawnImpl: deps.spawn });
      const ev = parseCodexEvents(r.stdout);
      if (r.code === 0 && !ev.error) {
        let text = ev.lastMessage ?? '';
        try {
          text = readFileSync(outFile, 'utf8');
        } catch {
          // Fall back to the last message event.
        }
        return {
          text,
          model: ev.model ?? config.model ?? 'codex-cli default',
          usage: { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens },
          latencyMs: Date.now() - started,
          costUsd: null,
        };
      }
      const detail = ev.error ?? (r.stderr.trim().slice(0, 300) || `exit code ${r.code}`);
      last = new Error(`codex CLI failed: ${detail}`);
      if (!looksTransient(detail)) throw last;
    } finally {
      removeWorkDir(dir);
    }
    if (attempt < 2) await sleep(backoff(attempt, null));
  }
  throw last;
}
