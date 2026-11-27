// Run a vendor CLI as a subprocess. Argument array, no shell, prompt on stdin, hard timeout,
// output size cap. Runs in a fresh empty temp dir so the CLI sees no project files.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_OUTPUT = 20 * 1024 * 1024;

export function makeWorkDir() {
  return mkdtempSync(join(tmpdir(), 'tokenshrink-'));
}

export function removeWorkDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leftover empty temp dir is harmless.
  }
}

export function runProcess(bin, args, { input = '', cwd, timeoutMs = 120000, env = process.env, spawnImpl = spawn, stdio } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(bin, args, { cwd, env, shell: false, stdio: stdio ?? ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
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
