import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCases, runEval, parseAnswer, score, formatReport } from '../src/eval.js';
import { createFakeProvider } from '../src/provider/fake.js';
import { openStore } from '../src/index.js';
import { example, tempDir, ROOT, SPAWN_TIMEOUT } from './helpers.js';

test('the shipped cases file loads', () => {
  const cases = loadCases(join(ROOT, 'examples', 'cases.jsonl'));
  assert.equal(cases.length, 2);
  assert.ok(cases.every((c) => c.context.length > 1000));
});

test('context_file may not leave the cases folder', (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'cases'));
  writeFileSync(join(dir, 'secret.txt'), 'top secret');
  writeFileSync(join(dir, 'cases', 'c.jsonl'), `${JSON.stringify({ id: 'a', question: 'q', expected: 'x', context_file: '../secret.txt' })}\n`);
  assert.throws(() => loadCases(join(dir, 'cases', 'c.jsonl')), /must stay inside the cases folder/);
  writeFileSync(join(dir, 'cases', 'c.jsonl'), `${JSON.stringify({ id: 'a', question: 'q', expected: 'x', context_file: join(dir, 'secret.txt') })}\n`);
  assert.throws(() => loadCases(join(dir, 'cases', 'c.jsonl')), /must stay inside the cases folder/);
  writeFileSync(join(dir, 'cases', 'c.jsonl'), '{"id":"a"}\n');
  assert.throws(() => loadCases(join(dir, 'cases', 'c.jsonl')), /question/);
});

test('answer parsing validates the schema', () => {
  assert.deepEqual(parseAnswer('{"answer":"42"}'), { value: '42' });
  assert.deepEqual(parseAnswer('```json\n{"answer": "x"}\n```'), { value: 'x' });
  assert.match(parseAnswer('42').error, /no JSON/);
  assert.match(parseAnswer('{"answer": 42}').error, /must be a string/);
  assert.equal(score('Order ord_1 failed with GATEWAY_TIMEOUT', { expected: ['ord_1', 'gateway_timeout'], match: 'contains' }), true);
  assert.equal(score('ord_1', { expected: ['ord_1', 'x'], match: 'contains' }), false);
  assert.equal(score(' 60 ', { expected: ['60'], match: 'exact' }), true);
});

test('runEval measures tokens and pass^k with retries and fail closed', { timeout: SPAWN_TIMEOUT }, async () => {
  const cases = [
    { id: 'c1', question: 'which order failed?', expected: ['ord_48213'], match: 'contains', context: example('app.log') },
    { id: 'c2', question: 'how many users?', expected: ['1000'], match: 'contains', context: example('users.json') },
  ];
  // c1 original passes every run, compressed passes after one invalid reply and a repair.
  // c2 compressed fails once, so its pass^k is 0.
  let n = 0;
  const provider = createFakeProvider((req) => {
    n++;
    const user = req.messages[0].content;
    const compressed = user.includes('[tokenshrink');
    const repair = req.messages.length > 1;
    if (user.includes('which order')) {
      if (compressed && !repair && n % 2 === 0) return 'I think it is ord_48213';
      return '{"answer":"ord_48213"}';
    }
    if (compressed && n % 3 === 0) return new Error('boom');
    return '{"answer":"1000 users"}';
  });
  const store = openStore({ memory: true });
  const rep = await runEval({ cases, provider, k: 3, store });
  store.close();
  const [c1, c2] = rep.cases;
  assert.equal(c1.original.pass, 3);
  assert.equal(c1.compressed.pass, 3);
  assert.ok(c1.estTokens.compressed < c1.estTokens.original / 10);
  assert.equal(c2.original.passAll, true);
  assert.ok(c2.compressed.errors >= 1);
  assert.equal(c2.compressed.passAll, false);
  assert.equal(rep.totals.original.passK, 100);
  assert.equal(rep.totals.compressed.passK, 50);
  assert.ok(rep.totals.measuredInputTokens.savedPercent > 50);
  assert.match(formatReport(rep), /pass\^3/);
});

test('an always invalid model fails closed after one repair', { timeout: SPAWN_TIMEOUT }, async () => {
  const provider = createFakeProvider(['not json']);
  const rep = await runEval({ cases: [{ id: 'x', question: 'q', expected: ['a'], match: 'contains', context: 'short context' }], provider, k: 2 });
  assert.equal(rep.cases[0].original.invalid, 2);
  assert.equal(rep.cases[0].original.pass, 0);
  assert.equal(provider.calls.length, 8);
  assert.match(provider.calls[1].messages[2].content, /not valid/);
});
