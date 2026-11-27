// Connect the user's own subscription through the official vendor CLIs. tokenshrink only
// starts those CLIs. It never reads, copies or reuses the tokens they store, and never calls a
// vendor API with them.

import { claudeArgs, parseClaudeOutput, writeSystemFile } from '../provider/claude-cli.js';
import { makeWorkDir, removeWorkDir, runProcess } from '../provider/subprocess.js';

export const VENDORS = {
  claude: {
    label: 'claude CLI',
    install: 'Install the official claude CLI first, for example: npm install -g @anthropic-ai/claude-code',
    loginArgs: ['auth', 'login'],
  },
  chatgpt: {
    label: 'codex CLI',
    install: 'Install the official codex CLI first, for example: npm install -g @openai/codex',
    loginArgs: ['login'],
  },
};

async function installed(bin, deps) {
  try {
    const r = await runProcess(bin, ['--version'], { timeoutMs: 20000, spawnImpl: deps.spawn });
    return r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0].slice(0, 80) : null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Quick check without a model call. Reads only the logged in flag, nothing else.
export async function claudeSignedIn(bin, deps = {}) {
  try {
    const r = await runProcess(bin, ['auth', 'status', '--json'], { timeoutMs: 20000, spawnImpl: deps.spawn });
    if (r.code !== 0) return false;
    const obj = JSON.parse(r.stdout);
    return obj?.loggedIn === true;
  } catch {
    return false;
  }
}

// The tiny print mode probe. One short model call with no tools.
export async function claudeProbe(bin, deps = {}) {
  const dir = makeWorkDir();
  try {
    const r = await runProcess(bin, claudeArgs({ systemFile: writeSystemFile(dir, 'Reply with the single word ok.') }), {
      input: 'ok?',
      cwd: dir,
      timeoutMs: 120000,
      spawnImpl: deps.spawn,
    });
    if (r.code !== 0) return false;
    return !parseClaudeOutput(r.stdout).isError;
  } catch {
    return false;
  } finally {
    removeWorkDir(dir);
  }
}

export async function codexSignedIn(bin, deps = {}) {
  try {
    const r = await runProcess(bin, ['login', 'status'], { timeoutMs: 20000, spawnImpl: deps.spawn });
    return r.code === 0 && /logged in/i.test(r.stdout + r.stderr) && !/not logged in/i.test(r.stdout + r.stderr);
  } catch {
    return false;
  }
}

export async function subscriptionStatus(vendor, bin, deps = {}) {
  const version = await installed(bin, deps);
  if (!version) return { vendor, installed: false, signedIn: false };
  const signedIn = vendor === 'claude' ? await claudeSignedIn(bin, deps) : await codexSignedIn(bin, deps);
  return { vendor, installed: true, version, signedIn };
}

// auth login claude | chatgpt
export async function subscriptionLogin(vendor, bin, deps = {}) {
  const v = VENDORS[vendor];
  if (!v) throw new Error(`unknown subscription ${vendor}, expected claude or chatgpt`);
  const print = deps.print ?? ((s) => process.stderr.write(`${s}\n`));
  const version = await installed(bin, deps);
  if (!version) {
    print(`${v.label} not found (${bin}). ${v.install}`);
    return { vendor, installed: false, signedIn: false };
  }
  const check = vendor === 'claude' ? () => claudeProbe(bin, deps) : () => codexSignedIn(bin, deps);
  if (await check()) {
    print(`${v.label} is already signed in. The ${vendor === 'claude' ? 'claude-cli' : 'codex-cli'} provider will use it.`);
    return { vendor, installed: true, signedIn: true, already: true };
  }
  print(`Starting the official sign in of the ${v.label}. Follow its instructions.`);
  const r = await runProcess(bin, v.loginArgs, { timeoutMs: 15 * 60000, spawnImpl: deps.spawn, stdio: 'inherit' });
  if (r.code !== 0) {
    print(`${v.label} sign in exited with code ${r.code}.`);
    return { vendor, installed: true, signedIn: false };
  }
  const ok = await check();
  print(ok ? `Signed in. Use --provider ${vendor === 'claude' ? 'claude-cli' : 'codex-cli'}.` : `${v.label} still does not answer as signed in.`);
  return { vendor, installed: true, signedIn: ok };
}
