#!/usr/bin/env node
// Writes the example inputs in examples/ from a fixed seed, so they are reproducible.
// Run: node scripts/make-examples.js

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');
mkdirSync(join(root, 'eval'), { recursive: true });

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = rng(20261127);
const pick = (arr) => arr[Math.floor(r() * arr.length)];
const int = (a, b) => a + Math.floor(r() * (b - a + 1));
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[int(0, 15)]).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
const pad = (n, w = 2) => String(n).padStart(w, '0');

function ts(base, ms) {
  return new Date(base + ms).toISOString();
}

// app.log
function makeLog(lines, opts = {}) {
  const base = Date.UTC(2026, 10, 20, 9, 0, 0);
  const out = [];
  let t = 0;
  const routes = ['/api/items', '/api/users', '/api/cart', '/api/search', '/healthz'];
  for (let i = 0; i < lines; i++) {
    t += int(5, 400);
    const at = ts(base, t);
    const roll = r();
    if (i === Math.floor(lines * 0.42)) {
      out.push(`${at} WARN  db-pool pool exhausted, waiting for connection (active=20 idle=0 waiting=14)`);
    } else if (i === Math.floor(lines * 0.61)) {
      out.push(`${at} ERROR payment-service charge failed order=${opts.order ?? 'ord_48213'} code=GATEWAY_TIMEOUT upstream=psp-eu-2 after 30000ms`);
      out.push('Error: upstream request timed out');
      out.push('    at PspClient.charge (/srv/app/src/payments/psp-client.js:88:15)');
      out.push('    at async ChargeService.run (/srv/app/src/payments/charge-service.js:41:22)');
      out.push('    at async /srv/app/node_modules/express/lib/router/layer.js:95:5');
      out.push('    at async next (/srv/app/node_modules/express/lib/router/route.js:149:13)');
      out.push('    at async Route.dispatch (/srv/app/node_modules/express/lib/router/route.js:119:3)');
      out.push('    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)');
    } else if (i > lines * 0.62 && i < lines * 0.62 + 40) {
      out.push(`${at} INFO  payment-service retrying charge order=${opts.order ?? 'ord_48213'} attempt=${i - Math.floor(lines * 0.62)}`);
    } else if (roll < 0.06) {
      out.push(`${at} DEBUG cache miss key=${hex(16)} ttl=300`);
    } else if (roll < 0.1) {
      out.push(`${at} INFO  heartbeat ok seq=${i} uptime=${Math.floor(t / 1000)}s`);
    } else if (roll < 0.105) {
      out.push(`${at} WARN  slow query took ${int(900, 2500)}ms sql="SELECT * FROM orders WHERE customer_id = $1"`);
    } else {
      const route = pick(routes);
      const id = route === '/healthz' ? '' : `/${int(1, 9999)}`;
      out.push(`${at} INFO  http GET ${route}${id} 200 ${int(2, 180)}ms req=${uuid()} ip=10.0.${int(0, 9)}.${int(1, 254)}`);
    }
  }
  return `${out.join('\n')}\n`;
}

// users.json
function makeUsers(n) {
  const first = ['Ada', 'Bela', 'Csilla', 'Dora', 'Emil', 'Fanni', 'Gergo', 'Hanna', 'Ivan', 'Julia', 'Kata', 'Laszlo'];
  const last = ['Kovacs', 'Nagy', 'Toth', 'Szabo', 'Horvath', 'Varga', 'Kiss', 'Molnar', 'Nemeth', 'Farkas'];
  const users = [];
  for (let i = 1; i <= n; i++) {
    const f = pick(first);
    const l = pick(last);
    users.push({
      id: i,
      email: `${f.toLowerCase()}.${l.toLowerCase()}${i}@example.com`,
      name: `${f} ${l}`,
      role: i % 97 === 0 ? 'admin' : r() < 0.15 ? 'editor' : 'viewer',
      active: r() < 0.82,
      created_at: `2025-${pad(int(1, 12))}-${pad(int(1, 28))}T${pad(int(0, 23))}:${pad(int(0, 59))}:00Z`,
      score: Math.round(r() * 10000) / 100,
      tags: Array.from({ length: int(0, 3) }, () => pick(['beta', 'vip', 'trial', 'churn-risk', 'partner'])),
      address: { city: pick(['Budapest', 'Debrecen', 'Szeged', 'Pecs', 'Gyor']), zip: String(int(1000, 9999)) },
    });
  }
  return `${JSON.stringify({ page: 1, per_page: n, total: n, generated_at: '2026-11-20T09:00:00Z', users }, null, 2)}\n`;
}

// orders.csv
function makeOrders(n) {
  const rows = ['order_id,date,customer,country,status,amount,currency,note'];
  for (let i = 1; i <= n; i++) {
    const status = pick(['shipped', 'shipped', 'shipped', 'pending', 'cancelled', 'returned']);
    const note = r() < 0.05 ? '"gift wrap, deliver after 5pm"' : '';
    rows.push(
      [
        `ord_${10000 + i}`,
        `2026-${pad(int(1, 10))}-${pad(int(1, 28))}`,
        `cust_${int(1, 800)}`,
        pick(['HU', 'AT', 'DE', 'SK', 'RO', 'PL']),
        status,
        (int(500, 250000) / 100).toFixed(2),
        'EUR',
        note,
      ].join(','),
    );
  }
  return `${rows.join('\n')}\n`;
}

function makeNodeTrace() {
  const lines = ['RangeError: Maximum call stack size exceeded', '    at walk (/srv/app/src/tree/walk.js:12:10)'];
  for (let i = 0; i < 120; i++) lines.push('    at walk (/srv/app/src/tree/walk.js:18:12)');
  lines.push('    at buildIndex (/srv/app/src/tree/index.js:44:3)');
  lines.push('    at /srv/app/node_modules/express/lib/router/layer.js:95:5');
  lines.push('    at next (/srv/app/node_modules/express/lib/router/route.js:149:13)');
  lines.push('    at Route.dispatch (/srv/app/node_modules/express/lib/router/route.js:119:3)');
  lines.push('    at Layer.handle [as handle_request] (/srv/app/node_modules/express/lib/router/layer.js:95:5)');
  lines.push('    at /srv/app/node_modules/express/lib/router/index.js:284:15');
  lines.push('    at Function.process_params (/srv/app/node_modules/express/lib/router/index.js:346:12)');
  lines.push('    at next (/srv/app/node_modules/express/lib/router/index.js:280:10)');
  lines.push('    at jsonParser (/srv/app/node_modules/body-parser/lib/types/json.js:113:7)');
  lines.push('    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)');
  return `${lines.join('\n')}\n`;
}

function makeJavaTrace() {
  const spring = [
    'org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:883)',
    'jakarta.servlet.http.HttpServlet.service(HttpServlet.java:658)',
    'org.apache.catalina.core.ApplicationFilterChain.internalDoFilter(ApplicationFilterChain.java:205)',
    'org.apache.catalina.core.ApplicationFilterChain.doFilter(ApplicationFilterChain.java:149)',
    'org.springframework.web.filter.RequestContextFilter.doFilterInternal(RequestContextFilter.java:100)',
    'org.springframework.web.filter.OncePerRequestFilter.doFilter(OncePerRequestFilter.java:116)',
    'org.springframework.security.web.FilterChainProxy.doFilter(FilterChainProxy.java:215)',
    'org.apache.catalina.core.StandardWrapperValve.invoke(StandardWrapperValve.java:166)',
    'org.apache.catalina.core.StandardContextValve.invoke(StandardContextValve.java:90)',
    'org.apache.coyote.http11.Http11Processor.service(Http11Processor.java:391)',
    'org.apache.tomcat.util.net.NioEndpoint$SocketProcessor.doRun(NioEndpoint.java:1744)',
    'java.base/java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1144)',
    'java.base/java.lang.Thread.run(Thread.java:1583)',
  ];
  const out = [
    'org.springframework.web.util.NestedServletException: Request processing failed; nested exception is com.acme.billing.InvoiceException: invoice 2026-118 has no tax id',
  ];
  out.push('\tat org.springframework.web.servlet.FrameworkServlet.processRequest(FrameworkServlet.java:1014)');
  for (let k = 0; k < 4; k++) for (const f of spring) out.push(`\tat ${f}`);
  out.push('Caused by: com.acme.billing.InvoiceException: invoice 2026-118 has no tax id');
  out.push('\tat com.acme.billing.InvoiceValidator.check(InvoiceValidator.java:57)');
  out.push('\tat com.acme.billing.InvoiceService.issue(InvoiceService.java:122)');
  out.push('\tat com.acme.billing.web.InvoiceController.issue(InvoiceController.java:48)');
  out.push('\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)');
  out.push('\tat java.base/java.lang.reflect.Method.invoke(Method.java:580)');
  for (const f of spring.slice(0, 8)) out.push(`\tat ${f}`);
  out.push('\t... 48 more');
  return `${out.join('\n')}\n`;
}

function makeHtml() {
  const nav = Array.from({ length: 30 }, (_, i) => `<li><a href="/docs/section-${i}">Section ${i}</a></li>`).join('\n');
  const script = `window.__STATE__ = ${JSON.stringify({ items: Array.from({ length: 300 }, (_, i) => ({ id: i, v: hex(12) })) })};`;
  const style = Array.from({ length: 200 }, (_, i) => `.c${i}{margin:${i}px;padding:${i % 7}px;color:#${hex(6)}}`).join('\n');
  const rows = Array.from({ length: 25 }, (_, i) => `<tr><td>v${i}.0</td><td>2026-${pad((i % 12) + 1)}-01</td><td>${pick(['stable', 'beta', 'deprecated'])}</td></tr>`).join('\n');
  const paras = Array.from(
    { length: 12 },
    (_, i) =>
      `<p>Paragraph ${i + 1}. The rate limiter allows <strong>${100 + i * 10}</strong> requests per minute per key. Requests above the limit get status 429 and a <code>retry-after</code> header &amp; should back off.</p>`,
  ).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Rate limits &amp; quotas | Example Docs</title>
<style>
${style}
</style>
<script>${script}</script>
</head>
<body>
<header><nav><ul>
${nav}
</ul></nav></header>
<main>
<h1>Rate limits &amp; quotas</h1>
${paras}
<h2>Release history</h2>
<table><thead><tr><th>Version</th><th>Date</th><th>Status</th></tr></thead><tbody>
${rows}
</tbody></table>
<h2>Contact</h2>
<p>Write to <a href="mailto:support@example.com">support</a> if you need a higher quota.</p>
</main>
<footer><nav><ul>
${nav}
</ul></nav><p>&copy; 2026 Example</p></footer>
<script src="/static/app.js"></script>
</body>
</html>
`;
}

function makeDiff() {
  const out = [];
  out.push('diff --git a/src/payments/psp-client.js b/src/payments/psp-client.js');
  out.push('index 3f2a1c0..8b9d4e2 100644');
  out.push('--- a/src/payments/psp-client.js');
  out.push('+++ b/src/payments/psp-client.js');
  const ctxLines = (from, n) => Array.from({ length: n }, (_, i) => ` const line${from + i} = compute(${from + i});`);
  out.push('@@ -80,13 +80,15 @@ export class PspClient {');
  out.push(...ctxLines(80, 6));
  out.push('-    const res = await fetch(url, { method: "POST", body });');
  out.push('+    const res = await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(this.timeoutMs) });');
  out.push('+    if (res.status === 429) throw new RetryableError("rate limited");');
  out.push('+    if (res.status >= 500) throw new RetryableError(`upstream ${res.status}`);');
  out.push(...ctxLines(87, 6));
  out.push('@@ -140,7 +142,8 @@ export class PspClient {');
  out.push(...ctxLines(140, 3));
  out.push('-  timeoutMs = 30000;');
  out.push('+  timeoutMs = 10000;');
  out.push('+  retries = 3;');
  out.push(...ctxLines(144, 3));
  out.push('diff --git a/package-lock.json b/package-lock.json');
  out.push('index 1111111..2222222 100644');
  out.push('--- a/package-lock.json');
  out.push('+++ b/package-lock.json');
  out.push('@@ -1,400 +1,420 @@');
  for (let i = 0; i < 400; i++) {
    if (i % 20 === 0) {
      out.push(`-      "integrity": "sha512-${hex(40)}",`);
      out.push(`+      "integrity": "sha512-${hex(40)}",`);
      out.push(`+      "resolved": "https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-1.0.${i}.tgz",`);
    } else {
      out.push(`       "pkg-${i}": "^1.0.${i}",`);
    }
  }
  out.push('diff --git a/test/psp-client.test.js b/test/psp-client.test.js');
  out.push('new file mode 100644');
  out.push('index 0000000..5c1d2e3');
  out.push('--- /dev/null');
  out.push('+++ b/test/psp-client.test.js');
  out.push('@@ -0,0 +1,30 @@');
  for (let i = 0; i < 30; i++) out.push(`+test("case ${i}", async () => { assert.equal(await run(${i}), ${i * 2}); });`);
  return `${out.join('\n')}\n`;
}

function makeNotes() {
  const s = [
    'The migration moves the billing tables to the new cluster in three steps.',
    'First the replica is created and kept in sync for at least one full day.',
    'Then writes are paused for about five minutes while the last changes are copied.',
    'Finally the application switches its connection string and writes resume.',
    'Rollback is possible until the old primary is decommissioned one week later.',
  ];
  const out = [];
  for (let i = 0; i < 160; i++) {
    out.push(`${s[i % s.length]} Note ${i + 1}.`);
    if (i % 5 === 4) out.push('');
  }
  return `${out.join('\n')}\n`;
}

writeFileSync(join(root, 'app.log'), makeLog(2500));
writeFileSync(join(root, 'users.json'), makeUsers(1000));
writeFileSync(join(root, 'orders.csv'), makeOrders(2000));
writeFileSync(join(root, 'node-trace.txt'), makeNodeTrace());
writeFileSync(join(root, 'java-trace.txt'), makeJavaTrace());
writeFileSync(join(root, 'page.html'), makeHtml());
writeFileSync(join(root, 'change.diff'), makeDiff());
writeFileSync(join(root, 'notes.txt'), makeNotes());
writeFileSync(join(root, 'eval', 'small.log'), makeLog(60, { order: 'ord_77031' }));
writeFileSync(join(root, 'eval', 'small.json'), makeUsers(25));

const cases = [
  {
    id: 'log-failed-order',
    context_file: 'eval/small.log',
    question: 'Which order id failed, and with which error code?',
    expected: ['ord_77031', 'GATEWAY_TIMEOUT'],
  },
  {
    id: 'json-user-count',
    context_file: 'eval/small.json',
    question: 'How many users are in the list? Answer with the number.',
    expected: ['25'],
  },
];
writeFileSync(join(root, 'cases.jsonl'), `${cases.map((c) => JSON.stringify(c)).join('\n')}\n`);
console.log('examples written to', root);
