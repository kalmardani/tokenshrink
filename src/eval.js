// Eval harness. For every case the model answers the same question twice, once with the
// original context and once with the compressed one, k times each. The answer is scored in
// code. The report gives tokens saved and accuracy as pass@1 (mean) and pass^k (all k runs
// pass), per case and in total.

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compress } from './compress.js';
import { estimateTokens } from './tokens.js';

export const PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'eval-answer.v1.md');
export const PROMPT_VERSION = 'eval-answer.v1';
const MAX_CONTEXT_CHARS = 2_000_000;

export class EvalError extends Error {}

export function loadCases(casesPath) {
  const abs = resolve(casesPath);
  const base = dirname(abs);
  const raw = readFileSync(abs, 'utf8');
  const cases = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    let c;
    try {
      c = JSON.parse(t);
    } catch (err) {
      throw new EvalError(`line ${i + 1} is not valid JSON: ${err.message}`);
    }
    cases.push(validateCase(c, i + 1, base));
  });
  if (cases.length === 0) throw new EvalError('cases file has no cases');
  return cases;
}

export function validateCase(c, lineNo, base) {
  const where = `case on line ${lineNo}`;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new EvalError(`${where} must be an object`);
  if (typeof c.id !== 'string' || !c.id) throw new EvalError(`${where} needs an id string`);
  if (typeof c.question !== 'string' || !c.question) throw new EvalError(`${where} needs a question string`);
  const expected = typeof c.expected === 'string' ? [c.expected] : c.expected;
  if (!Array.isArray(expected) || expected.length === 0 || !expected.every((e) => typeof e === 'string' && e)) {
    throw new EvalError(`${where} needs expected as a string or a list of strings`);
  }
  if (c.match !== undefined && !['contains', 'exact'].includes(c.match)) throw new EvalError(`${where} match must be contains or exact`);
  let context;
  if (typeof c.context === 'string') context = c.context;
  else if (typeof c.context_file === 'string') {
    const file = resolve(base, c.context_file);
    const rel = relative(base, file);
    // A cases file may only read files in its own folder tree. Otherwise a shared cases file
    // could send any local file to the model provider.
    if (rel.startsWith('..') || isAbsolute(rel)) throw new EvalError(`${where} context_file must stay inside the cases folder`);
    context = readFileSync(file, 'utf8');
  } else throw new EvalError(`${where} needs context or context_file`);
  if (context.length > MAX_CONTEXT_CHARS) throw new EvalError(`${where} context is larger than ${MAX_CONTEXT_CHARS} chars`);
  return { id: c.id, question: c.question, expected, match: c.match ?? 'contains', context };
}

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function score(answer, c) {
  const a = norm(answer);
  if (c.match === 'exact') return c.expected.some((e) => norm(e) === a);
  return c.expected.every((e) => a.includes(norm(e)));
}

// Hand written schema check for the model reply. Returns { value } or { error }.
export function parseAnswer(text) {
  let t = String(text ?? '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1];
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end < start) return { error: 'reply has no JSON object' };
  let obj;
  try {
    obj = JSON.parse(t.slice(start, end + 1));
  } catch (err) {
    return { error: `reply is not valid JSON: ${err.message}` };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'reply must be a JSON object' };
  if (typeof obj.answer !== 'string') return { error: 'field answer must be a string' };
  if (obj.answer.length === 0 || obj.answer.length > 2000) return { error: 'field answer must have 1 to 2000 characters' };
  return { value: obj.answer };
}

async function ask(provider, system, context, question) {
  const user = `<context>\n${context}\n</context>\n\n<question>\n${question}\n</question>`;
  const messages = [{ role: 'user', content: user }];
  const calls = [];
  let reply = await provider.complete({ system, messages, maxTokens: 300 });
  calls.push(reply);
  let parsed = parseAnswer(reply.text);
  let repaired = false;
  if (parsed.error) {
    repaired = true;
    const retry = [
      ...messages,
      { role: 'assistant', content: reply.text.slice(0, 2000) },
      { role: 'user', content: `Your reply was not valid (${parsed.error}). Reply with only the JSON object {"answer": "..."}.` },
    ];
    reply = await provider.complete({ system, messages: retry, maxTokens: 300 });
    calls.push(reply);
    parsed = parseAnswer(reply.text);
  }
  const sum = (f) => calls.reduce((a, c) => (c.usage?.[f] == null || a == null ? null : a + c.usage[f]), 0);
  return {
    answer: parsed.value ?? null,
    invalid: Boolean(parsed.error),
    repaired,
    model: reply.model,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    latencyMs: calls.reduce((a, c) => a + (c.latencyMs ?? 0), 0),
    costUsd: calls.every((c) => typeof c.costUsd === 'number') ? calls.reduce((a, c) => a + c.costUsd, 0) : null,
  };
}

export async function runEval({ cases, provider, k = 3, level, budget, store = null, onProgress, systemPrompt }) {
  if (!Number.isInteger(k) || k < 1 || k > 20) throw new EvalError('k must be an integer from 1 to 20');
  const system = systemPrompt ?? readFileSync(PROMPT_FILE, 'utf8');
  const results = [];
  const models = new Set();
  for (const c of cases) {
    const comp = compress(c.context, { store, level, budget, source: 'eval' });
    const variants = { original: c.context, compressed: comp.text };
    const row = {
      id: c.id,
      type: comp.type,
      estTokens: { original: estimateTokens(c.context), compressed: comp.tokens },
      original: { pass: 0, invalid: 0, errors: 0, inputTokens: [], answers: [] },
      compressed: { pass: 0, invalid: 0, errors: 0, inputTokens: [], answers: [] },
      costUsd: 0,
      costKnown: true,
    };
    for (const variant of ['original', 'compressed']) {
      for (let run = 0; run < k; run++) {
        onProgress?.({ id: c.id, variant, run: run + 1, k });
        const v = row[variant];
        try {
          const r = await ask(provider, system, variants[variant], c.question);
          models.add(r.model);
          if (r.inputTokens != null) v.inputTokens.push(r.inputTokens);
          if (r.costUsd == null) row.costKnown = false;
          else row.costUsd += r.costUsd;
          if (r.invalid) v.invalid++;
          else if (score(r.answer, c)) v.pass++;
          v.answers.push(r.answer);
        } catch (err) {
          // A failed call counts as a failed run. The harness fails closed, never open.
          v.errors++;
          v.answers.push(null);
          v.lastError = String(err.message ?? err).slice(0, 300);
        }
      }
    }
    for (const variant of ['original', 'compressed']) {
      const v = row[variant];
      v.passAll = v.pass === k;
      v.meanInputTokens = v.inputTokens.length ? Math.round(v.inputTokens.reduce((a, b) => a + b, 0) / v.inputTokens.length) : null;
    }
    results.push(row);
  }
  return summarize(results, { k, provider: provider.name, models: [...models], promptVersion: PROMPT_VERSION });
}

export function summarize(results, meta) {
  const n = results.length;
  const k = meta.k;
  const sum = (f) => results.reduce((a, r) => a + f(r), 0);
  const estOrig = sum((r) => r.estTokens.original);
  const estComp = sum((r) => r.estTokens.compressed);
  const measured = results.every((r) => r.original.meanInputTokens != null && r.compressed.meanInputTokens != null);
  const measOrig = measured ? sum((r) => r.original.meanInputTokens) : null;
  const measComp = measured ? sum((r) => r.compressed.meanInputTokens) : null;
  const pct = (a, b) => (a > 0 ? Math.round(((a - b) / a) * 1000) / 10 : 0);
  const rate = (variant) => ({
    pass1: Math.round((sum((r) => r[variant].pass) / (n * k)) * 1000) / 10,
    passK: Math.round((sum((r) => (r[variant].passAll ? 1 : 0)) / n) * 1000) / 10,
    invalid: sum((r) => r[variant].invalid),
    errors: sum((r) => r[variant].errors),
  });
  return {
    ...meta,
    cases: results,
    totals: {
      cases: n,
      estTokens: { original: estOrig, compressed: estComp, savedPercent: pct(estOrig, estComp) },
      measuredInputTokens: measured ? { original: measOrig, compressed: measComp, savedPercent: pct(measOrig, measComp) } : null,
      original: rate('original'),
      compressed: rate('compressed'),
      costUsd: results.every((r) => r.costKnown) ? Math.round(sum((r) => r.costUsd) * 10000) / 10000 : null,
    },
  };
}

export function formatReport(rep) {
  const k = rep.k;
  const lines = [];
  lines.push(`provider ${rep.provider}, model ${rep.models.join(', ') || 'unknown'}, prompt ${rep.promptVersion}, k=${k}`);
  lines.push('');
  lines.push('| case | type | est. tokens original | est. tokens compressed | measured input original | measured input compressed | pass original | pass compressed |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const r of rep.cases) {
    lines.push(
      `| ${r.id} | ${r.type} | ${r.estTokens.original} | ${r.estTokens.compressed} | ${r.original.meanInputTokens ?? 'n/a'} | ${r.compressed.meanInputTokens ?? 'n/a'} | ${r.original.pass}/${k} | ${r.compressed.pass}/${k} |`,
    );
  }
  const t = rep.totals;
  lines.push('');
  lines.push(`estimated tokens ${t.estTokens.original} to ${t.estTokens.compressed}, ${t.estTokens.savedPercent} percent saved`);
  if (t.measuredInputTokens) {
    const m = t.measuredInputTokens;
    lines.push(`measured input tokens ${m.original} to ${m.compressed}, ${m.original - m.compressed} fewer, ${m.savedPercent} percent saved`);
    lines.push('(provider reported, per run mean summed over cases, includes the prompt and any fixed overhead of the provider)');
  }
  lines.push(`original    pass@1 ${t.original.pass1} percent, pass^${k} ${t.original.passK} percent, invalid ${t.original.invalid}, errors ${t.original.errors}`);
  lines.push(`compressed  pass@1 ${t.compressed.pass1} percent, pass^${k} ${t.compressed.passK} percent, invalid ${t.compressed.invalid}, errors ${t.compressed.errors}`);
  if (t.costUsd !== null) lines.push(`reported cost ${t.costUsd} USD`);
  const errs = rep.cases.flatMap((r) => ['original', 'compressed'].filter((v) => r[v].lastError).map((v) => `${r.id} ${v} ${r[v].lastError}`));
  if (errs.length) lines.push('', 'errors', ...errs);
  return lines.join('\n');
}
