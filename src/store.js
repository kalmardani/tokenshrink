// Content addressed store on node:sqlite. Every original and every derived text is kept under
// the sha256 of its UTF-8 bytes, compressed with raw deflate. There is deliberately no column
// for request headers, URLs or credentials, so nothing of that kind can be recorded here.

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { HandleError, MIN_ID, countLines, sliceSpan } from './handles.js';

const require = createRequire(import.meta.url);
const SCHEMA_VERSION = 1;
const SOURCES = ['api', 'cli', 'proxy', 'mcp', 'eval'];

export function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function defaultDataDir(env = process.env) {
  return env.TOKENSHRINK_DIR ? resolve(env.TOKENSHRINK_DIR) : join(homedir(), '.tokenshrink');
}

let sqlite;
function loadSqlite() {
  if (sqlite) return sqlite;
  // node:sqlite prints an experimental warning on load. Silence only that one warning.
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const msg = typeof warning === 'string' ? warning : warning?.message ?? '';
    if (/sqlite/i.test(msg)) return;
    return original.call(process, warning, ...rest);
  };
  try {
    sqlite = require('node:sqlite');
  } catch (err) {
    const e = new Error(
      'node:sqlite is not available. Use Node 22.13 or newer, or run Node 22.5 to 22.12 with --experimental-sqlite',
    );
    e.code = 'NO_SQLITE';
    e.cause = err;
    throw e;
  } finally {
    process.emitWarning = original;
  }
  return sqlite;
}

export function openStore(opts = {}) {
  const { DatabaseSync } = loadSqlite();
  let file = ':memory:';
  if (!opts.memory) {
    const dir = opts.dir ? resolve(opts.dir) : defaultDataDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    file = join(dir, 'tokenshrink.db');
  }
  const db = new DatabaseSync(file);
  if (file !== ':memory:') {
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows has no POSIX modes. The file inherits the user profile ACL there.
    }
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);

  const q = {
    insert: db.prepare(
      'INSERT OR IGNORE INTO blobs (hash, created_at, type, parent, chars, lines, content) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    get: db.prepare('SELECT hash, created_at, type, parent, chars, lines, content FROM blobs WHERE hash = ?'),
    prefix: db.prepare('SELECT hash FROM blobs WHERE hash >= ? AND hash < ? ORDER BY hash LIMIT 3'),
    run: db.prepare(
      'INSERT INTO runs (created_at, hash, source, type, level, original_tokens, compressed_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    forget: db.prepare('DELETE FROM blobs WHERE hash = ? OR parent = ?'),
    prune: db.prepare('DELETE FROM blobs WHERE created_at <= ?'),
  };

  const store = {
    file,
    put(text, meta = {}) {
      const hash = meta.hash ?? hashText(text);
      const content = deflateRawSync(Buffer.from(text, 'utf8'));
      q.insert.run(hash, new Date().toISOString(), meta.type ?? 'text', meta.parent ?? null, text.length, countLines(text), content);
      return hash;
    },
    has(hash) {
      return q.get.get(hash) !== undefined;
    },
    get(hash) {
      const row = q.get.get(hash);
      if (!row) return null;
      return {
        hash: row.hash,
        createdAt: row.created_at,
        type: row.type,
        parent: row.parent,
        chars: row.chars,
        lines: row.lines,
        text: inflateRawSync(row.content).toString('utf8'),
      };
    },
    // Resolve a hex prefix to one full hash. Ambiguity fails closed.
    resolve(prefix) {
      const p = String(prefix).toLowerCase();
      if (!/^[0-9a-f]{4,64}$/.test(p)) throw new HandleError('BAD_HANDLE', 'handle id must be 4 to 64 hex characters');
      const rows = q.prefix.all(p, `${p}g`);
      if (rows.length === 0) throw new HandleError('NOT_FOUND', `no stored original for ts:${p}`);
      if (rows.length > 1) throw new HandleError('AMBIGUOUS', `ts:${p} matches more than one stored original`);
      return rows[0].hash;
    },
    // Shortest prefix of at least MIN_ID characters that no other stored blob shares.
    shortId(hash) {
      for (let len = MIN_ID; len < 64; len += 2) {
        const p = hash.slice(0, len);
        const rows = q.prefix.all(p, `${p}g`);
        if (rows.every((r) => r.hash === hash)) return p;
      }
      return hash;
    },
    expand(handle) {
      const hash = store.resolve(handle.id);
      const blob = store.get(hash);
      return { blob, text: sliceSpan(blob.text, handle) };
    },
    recordRun(r) {
      if (!SOURCES.includes(r.source)) throw new Error(`unknown source ${r.source}`);
      q.run.run(new Date().toISOString(), r.hash, r.source, r.type, r.level, r.originalTokens, r.compressedTokens);
    },
    stats() {
      const blobs = db.prepare('SELECT count(*) AS n, coalesce(sum(chars), 0) AS chars, coalesce(sum(length(content)), 0) AS bytes FROM blobs').get();
      const totals = db
        .prepare('SELECT count(*) AS runs, coalesce(sum(original_tokens), 0) AS original, coalesce(sum(compressed_tokens), 0) AS compressed FROM runs')
        .get();
      const byType = db
        .prepare(
          'SELECT type, count(*) AS runs, sum(original_tokens) AS original, sum(compressed_tokens) AS compressed FROM runs GROUP BY type ORDER BY type',
        )
        .all();
      const bySource = db
        .prepare(
          'SELECT source, count(*) AS runs, sum(original_tokens) AS original, sum(compressed_tokens) AS compressed FROM runs GROUP BY source ORDER BY source',
        )
        .all();
      return {
        file,
        blobs: Number(blobs.n),
        chars: Number(blobs.chars),
        storedBytes: Number(blobs.bytes),
        runs: Number(totals.runs),
        originalTokens: Number(totals.original),
        compressedTokens: Number(totals.compressed),
        byType: byType.map(plain),
        bySource: bySource.map(plain),
      };
    },
    forget(prefix) {
      const hash = store.resolve(prefix);
      return Number(q.forget.run(hash, hash).changes);
    },
    prune(days) {
      if (!Number.isFinite(days) || days < 0) throw new Error('days must be a number >= 0');
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      return Number(q.prune.run(cutoff).changes);
    },
    close() {
      db.close();
    },
  };
  return store;
}

function plain(row) {
  const o = {};
  for (const [k, v] of Object.entries(row)) o[k] = typeof v === 'bigint' ? Number(v) : v;
  return o;
}

function migrate(db) {
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version > SCHEMA_VERSION) {
    throw new Error(`store schema ${version} is newer than this tokenshrink (${SCHEMA_VERSION})`);
  }
  if (version === SCHEMA_VERSION) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS blobs (
      hash TEXT PRIMARY KEY CHECK (length(hash) = 64),
      created_at TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('json','log','stacktrace','html','csv','diff','text')),
      parent TEXT REFERENCES blobs(hash) ON DELETE CASCADE,
      chars INTEGER NOT NULL CHECK (chars >= 0),
      lines INTEGER NOT NULL CHECK (lines >= 0),
      content BLOB NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS blobs_created ON blobs(created_at);
    CREATE INDEX IF NOT EXISTS blobs_parent ON blobs(parent);
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL,
      hash TEXT NOT NULL REFERENCES blobs(hash) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('api','cli','proxy','mcp','eval')),
      type TEXT NOT NULL,
      level INTEGER NOT NULL,
      original_tokens INTEGER NOT NULL,
      compressed_tokens INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS runs_hash ON runs(hash);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}
