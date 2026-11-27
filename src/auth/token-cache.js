// OAuth token cache. One JSON file in the per user config dir, mode 0600 where the OS supports
// it, written atomically. Entries are keyed by token URL, client id and scope.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './paths.js';

export function cacheKey(cfg) {
  return [cfg.tokenUrl, cfg.clientId, cfg.scope ?? ''].join('|');
}

export function createTokenCache(opts = {}) {
  const dir = opts.dir ?? configDir();
  const file = join(dir, 'tokens.json');

  function readAll() {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data && typeof data === 'object' && data.entries && typeof data.entries === 'object') return data;
    } catch {
      // Missing or unreadable cache means no cached tokens.
    }
    return { version: 1, entries: {} };
  }

  function writeAll(data) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // No POSIX modes on Windows.
    }
    renameSync(tmp, file);
  }

  return {
    file,
    get(key) {
      return readAll().entries[key] ?? null;
    },
    set(key, entry) {
      const data = readAll();
      data.entries[key] = entry;
      writeAll(data);
    },
    delete(key) {
      const data = readAll();
      if (!(key in data.entries)) return false;
      delete data.entries[key];
      writeAll(data);
      return true;
    },
    keys() {
      return Object.keys(readAll().entries);
    },
  };
}
