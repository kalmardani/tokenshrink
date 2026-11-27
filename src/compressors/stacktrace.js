// Stack trace compressor. Exception messages and application frames stay, runs of library or
// runtime frames fold into one marker that names the packages, and deep recursion collapses.

import { FRAME_RE } from '../detect.js';
import { renderPlan, splitLines } from '../plan.js';

export const LEVELS = [
  { minFold: 3, maxAppFrames: Infinity, sameFrame: 3 },
  { minFold: 2, maxAppFrames: Infinity, sameFrame: 2 },
  { minFold: 2, maxAppFrames: 12, sameFrame: 1 },
  { minFold: 2, maxAppFrames: 6, sameFrame: 1 },
  { minFold: 2, maxAppFrames: 3, sameFrame: 1 },
];

const JAVA_LIB =
  /^\s+at\s+((?:java|javax|jakarta|jdk|sun|com\.sun|kotlin|kotlinx|scala|org\.springframework|org\.apache|org\.hibernate|org\.junit|org\.eclipse|io\.netty|io\.micronaut|io\.quarkus|reactor|com\.fasterxml|System|Microsoft)(?:\.[a-z]\w*)?)/;

export function isFrameLine(line) {
  return FRAME_RE.test(line);
}

export function classifyFrame(line) {
  let m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(line);
  if (m) return { library: true, pkg: m[1].replace(/\\/g, '/') };
  if (/\bnode:|\(internal[\\/]|\binternal[\\/](?:modules|process|timers|streams)/.test(line)) return { library: true, pkg: 'node' };
  m = /(?:site|dist)-packages[\\/]([^\\/"]+)/.exec(line);
  if (m) return { library: true, pkg: m[1] };
  if (/<frozen |[\\/]lib[\\/]python\d(?:\.\d+)?[\\/]/.test(line)) return { library: true, pkg: 'python' };
  m = JAVA_LIB.exec(line);
  if (m) return { library: true, pkg: m[1] };
  m = /[\\/]pkg[\\/]mod[\\/]([^@]+)@/.exec(line);
  if (m) return { library: true, pkg: m[1].replace(/\\/g, '/') };
  if (/[\\/]go[\\/]src[\\/]|[\\/]usr[\\/]local[\\/]go[\\/]|^\s*runtime[\\/.]/.test(line)) return { library: true, pkg: 'go runtime' };
  m = /\.cargo[\\/]registry[\\/]src[\\/][^\\/]+[\\/]([^\\/]+?)-\d/.exec(line);
  if (m) return { library: true, pkg: m[1] };
  if (/[\\/]rustc[\\/]/.test(line)) return { library: true, pkg: 'rust std' };
  m = /[\\/]gems[\\/]([^\\/]+?)-\d/.exec(line);
  if (m) return { library: true, pkg: m[1] };
  if (/[\\/]vendor[\\/]/.test(line)) return { library: true, pkg: 'vendor' };
  return { library: false, pkg: '' };
}

export function compressStacktrace(text, level, ctx) {
  const p = LEVELS[Math.min(level, LEVELS.length - 1)];
  const lines = splitLines(text);
  const n = lines.length;
  // owner[i] is the index of the frame line a continuation line belongs to, or -1.
  const owner = new Int32Array(n).fill(-1);
  const frame = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (isFrameLine(lines[i])) {
      frame[i] = 1;
      owner[i] = i;
    }
  }
  for (let i = 0; i < n; i++) {
    // Python: the source line printed under a File line.
    if (!frame[i] && i > 0 && owner[i - 1] !== -1 && /^\s+File\s+"/.test(lines[owner[i - 1]]) && owner[i - 1] === i - 1 && /^\s{4,}\S/.test(lines[i])) {
      owner[i] = i - 1;
    }
    // Go: the function line printed above its file line.
    if (!frame[i] && i + 1 < n && frame[i + 1] && /\.go:\d+/.test(lines[i + 1]) && /^[\w./*()-]+\(.*\)\s*$/.test(lines[i])) {
      owner[i] = i + 1;
    }
  }

  const keep = new Uint8Array(n);
  const lib = new Uint8Array(n);
  const pkgOf = new Array(n).fill('');
  let appInBlock = 0;
  let firstInBlock = true;
  let sameRun = 0;
  for (let i = 0; i < n; i++) {
    if (!frame[i]) {
      if (owner[i] === -1) {
        keep[i] = 1;
        appInBlock = 0;
        firstInBlock = true;
        sameRun = 0;
      }
      continue;
    }
    const f = classifyFrame(lines[i]);
    lib[i] = f.library ? 1 : 0;
    pkgOf[i] = f.pkg;
    const prevFrame = previousFrame(i);
    sameRun = prevFrame !== -1 && lines[prevFrame].trim() === lines[i].trim() ? sameRun + 1 : 0;
    let show;
    if (firstInBlock) show = true;
    else if (sameRun >= p.sameFrame) show = false;
    else if (f.library) show = false;
    else show = appInBlock < p.maxAppFrames;
    if (!f.library) appInBlock++;
    firstInBlock = false;
    keep[i] = show ? 1 : 0;
  }
  // Continuation lines follow their frame.
  for (let i = 0; i < n; i++) {
    if (!frame[i] && owner[i] !== -1) keep[i] = keep[owner[i]];
  }

  function previousFrame(i) {
    for (let k = i - 1; k >= 0; k--) {
      if (frame[k]) return k;
      if (owner[k] === -1) return -1;
    }
    return -1;
  }

  return renderPlan(lines, keep, {
    ctx,
    text,
    minOmit: p.minFold,
    maxLineChars: 600,
    summarize(from, to) {
      let frames = 0;
      let libs = 0;
      let same = 0;
      const pkgs = new Map();
      for (let k = from; k <= to; k++) {
        if (!frame[k]) continue;
        frames++;
        const prev = previousFrame(k);
        if (prev !== -1 && lines[prev].trim() === lines[k].trim()) same++;
        if (lib[k]) {
          libs++;
          pkgs.set(pkgOf[k], (pkgs.get(pkgOf[k]) ?? 0) + 1);
        }
      }
      const parts = [];
      if (same > frames / 2) parts.push(`${frames} frames, ${same} repeat the frame above`);
      else if (libs === frames) parts.push(`${frames} library frames`);
      else parts.push(`${frames} frames, ${libs} from libraries`);
      const list = [...pkgs.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4);
      if (list.length) parts.push(list.map(([k, c]) => `${k} ${c}`).join(', '));
      return parts.join('; ');
    },
  });
}
