// Run a vendor CLI as a subprocess. Argument array, never shell: true, prompt on stdin, hard
// timeout, output size cap. Runs in a fresh empty temp dir so the CLI sees no project files.
//
// Windows. npm installs CLIs as .cmd shims, which CreateProcess cannot start directly. The
// command is resolved with PATH and PATHEXT. An .exe is spawned directly. A .cmd or .bat goes
// through cmd.exe /d /s /c with every argument quoted and every cmd metacharacter escaped, and
// arguments that cmd cannot carry safely (%, ", line breaks, NUL) are refused. See ADR 0007.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, win32 } from 'node:path';

const MAX_OUTPUT = 20 * 1024 * 1024;

export function makeWorkDir() {
  return mkdtempSync(join(tmpdir(), 'tokenshrink-'));
}

export function removeWorkDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A leftover temp dir is harmless.
  }
}

const isFile = (p) => {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
};

// Find the file Windows would run for a bare command name.
export function findWindowsExecutable(bin, env = process.env, exists = isFile) {
  if (/[\\/]/.test(bin) || win32.isAbsolute(bin)) {
    if (extname(bin)) return exists(bin) ? bin : null;
    for (const ext of pathExts(env)) if (exists(bin + ext)) return bin + ext;
    return exists(bin) ? bin : null;
  }
  const dirs = String(env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  for (const dir of dirs) {
    const base = win32.join(dir.replace(/^"|"$/g, ''), bin);
    if (extname(bin) && exists(base)) return base;
    for (const ext of pathExts(env)) if (exists(base + ext)) return base + ext;
  }
  return null;
}

function pathExts(env) {
  return String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((e) => e.toLowerCase());
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

// Quote one argument for cmd.exe /s /c. The inner part follows the CreateProcess rules for
// backslashes and quotes, then every cmd metacharacter, the quotes included, gets a caret, so
// cmd sees no unescaped special character at all.
export function quoteForCmd(arg) {
  const s = String(arg);
  if (/[%"\r\n\0]/.test(s)) {
    throw new Error('argument contains a character that cannot be passed safely through cmd.exe (%, ", line break or NUL)');
  }
  let q = s.replace(/(\\*)$/, '$1$1');
  q = `"${q}"`;
  return q.replace(CMD_META, '^$1');
}

// Returns what to pass to spawn for bin and args on this platform.
export function resolveCommand(bin, args, { platform = process.platform, env = process.env, exists } = {}) {
  if (platform !== 'win32') return { command: bin, args, options: {} };
  const found = findWindowsExecutable(bin, env, exists) ?? bin;
  const ext = extname(found).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const line = [quoteForCmd(found), ...args.map(quoteForCmd)].join(' ');
    return {
      command: env.ComSpec || env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      options: { windowsVerbatimArguments: true },
      shim: found,
    };
  }
  return { command: found, args, options: {} };
}

function killTree(child, platform) {
  if (platform === 'win32' && child.pid) {
    // cmd.exe would die alone and leave the CLI running. taskkill /T ends the whole tree.
    try {
      const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      k.on('error', () => child.kill());
      return;
    } catch {
      // Fall through to a plain kill.
    }
  }
  child.kill();
}

export function runProcess(
  bin,
  args,
  { input = '', cwd, timeoutMs = 120000, env = process.env, spawnImpl = spawn, stdio, platform = process.platform } = {},
) {
  return new Promise((resolve, reject) => {
    let child;
    let resolved;
    try {
      resolved = resolveCommand(bin, args, { platform, env });
      child = spawnImpl(resolved.command, resolved.args, {
        cwd,
        env,
        shell: false,
        stdio: stdio ?? ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...resolved.options,
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      killTree(child, platform);
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        const e = new Error(`${bin} was not found on PATH`);
        e.code = 'ENOENT';
        reject(e);
      } else reject(err);
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT) stderr += d;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        const e = new Error(`${bin} did not finish within ${timeoutMs} ms`);
        e.code = 'TIMEOUT';
        reject(e);
        return;
      }
      resolve({ code, stdout, stderr });
    });
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

// Flatten a chat into one prompt for CLIs that take a single prompt.
export function flattenMessages(messages) {
  if (messages.length === 1) return messages[0].content;
  return messages.map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`).join('\n\n');
}

export function looksTransient(text) {
  return /rate.?limit|overloaded|\b429\b|\b5\d\d\b|timed? ?out|temporarily/i.test(text ?? '');
}

