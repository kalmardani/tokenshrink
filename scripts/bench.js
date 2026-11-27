#!/usr/bin/env node
// Runs the CLI on every example file and prints a Markdown table of the measured result.
// Run: node scripts/bench.js

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'tokenshrink.js');
const files = ['app.log', 'users.json', 'orders.csv', 'node-trace.txt', 'java-trace.txt', 'page.html', 'change.diff', 'notes.txt'];
const dataDir = mkdtempSync(join(tmpdir(), 'tokenshrink-bench-'));

const rows = [];
let sumIn = 0;
let sumOut = 0;
for (const f of files) {
  const path = join(root, 'examples', f);
  const started = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [bin, 'compress', path, '--json', '--data-dir', dataDir], { encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (r.status !== 0) {
    process.stderr.write(r.stderr);
    process.exit(1);
  }
  const rep = JSON.parse(r.stdout);
  const bytes = statSync(path).size;
  const outBytes = Buffer.byteLength(rep.text, 'utf8');
  sumIn += rep.originalTokens;
  sumOut += rep.tokens;
  const saved = Math.round(((rep.originalTokens - rep.tokens) / rep.originalTokens) * 1000) / 10;
  rows.push(`| ${f} | ${rep.type} | ${bytes} | ${outBytes} | ${rep.originalTokens} | ${rep.tokens} | ${saved} | ${Math.round(ms)} |`);
}
rmSync(dataDir, { recursive: true, force: true });
const total = Math.round(((sumIn - sumOut) / sumIn) * 1000) / 10;
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
console.log(`tokenshrink ${version}, node ${process.versions.node}, ${process.platform}, default level 1`);
console.log('');
console.log('| file | type | bytes in | bytes out | tokens in (est.) | tokens out (est.) | saved % | wall ms |');
console.log('|---|---|---:|---:|---:|---:|---:|---:|');
for (const r of rows) console.log(r);
console.log(`| total | | | | ${sumIn} | ${sumOut} | ${total} | |`);
