// Fake provider for tests. Scripted replies, no network. A reply can be a string, a function of
// the request, or an Error to throw.

export function createFakeProvider(script = ['{"answer":"fake"}']) {
  const calls = [];
  let i = 0;
  return {
    name: 'fake',
    model: 'fake-1',
    calls,
    async complete(req) {
      calls.push(req);
      const step = typeof script === 'function' ? script(req, calls.length - 1) : script[Math.min(i++, script.length - 1)];
      if (step instanceof Error) throw step;
      const text = typeof step === 'function' ? step(req) : String(step);
      const input = [req.system ?? '', ...req.messages.map((m) => m.content)].join('\n');
      return {
        text,
        model: 'fake-1',
        usage: { inputTokens: Math.ceil(input.length / 4), outputTokens: Math.ceil(text.length / 4) },
        latencyMs: 0,
        costUsd: 0,
      };
    },
  };
}
