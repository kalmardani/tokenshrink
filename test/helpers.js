import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMarkers } from '../src/handles.js';
import { splitLines } from '../src/plan.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const example = (name) => readFileSync(join(ROOT, 'examples', name), 'utf8');

export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenshrink-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Rebuild the original lines from a compressed output of a line based compressor. Every line
// marker is replaced by its expansion and every cut line gets its chars marker expanded.
// Lines from the CSV statistics block on are ignored.
export function rebuild(output, store) {
  const lines = output.split('\n');
  const body = lines[0].startsWith('[tokenshrink') ? lines.slice(1) : lines;
  const out = [];
  for (const line of body) {
    if (line.startsWith('[stats ')) break;
    const marks = findMarkers(line);
    if (marks.length === 1 && marks[0].text === line && marks[0].kind === 'lines') {
      const h = { id: marks[0].id, kind: 'lines', start: marks[0].start, end: marks[0].end };
      out.push(...splitLines(`${store.expand(h).text}\n`));
      continue;
    }
    const chars = marks.find((m) => m.kind === 'chars');
    if (chars && line.endsWith(chars.text)) {
      const prefix = line.slice(0, line.length - chars.text.length - 1);
      const h = { id: chars.id, kind: 'chars', start: chars.start, end: chars.end };
      out.push(prefix + store.expand(h).text);
      continue;
    }
    out.push(line);
  }
  return out;
}
