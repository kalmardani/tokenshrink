// HTML compressor. Turns markup into readable text with headings, list items, table rows and
// link targets, drops scripts, styles and other non content. The extracted text is stored as a
// derived blob and then goes through the text compressor, so its markers expand to exact lines
// of the extracted text, and the header handle still returns the original markup.

import { compressText } from './text.js';

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'canvas', 'head', 'math']);
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside', 'ul', 'ol', 'dl', 'dt', 'dd',
  'table', 'form', 'fieldset', 'blockquote', 'pre', 'figure', 'figcaption',
  'address', 'details', 'summary', 'body', 'html', 'caption', 'label', 'legend', 'option', 'select', 'textarea',
]);
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'base', 'col', 'embed', 'param', 'track']);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '(c)', reg: '(R)', trade: '(TM)',
  hellip: '...', mdash: '-', ndash: '-', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', bull: '*',
  middot: '*', laquo: '<<', raquo: '>>', times: 'x', euro: 'EUR', pound: 'GBP', yen: 'JPY', deg: ' deg',
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attr(attrs, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

export function htmlToText(html, level = 1) {
  const dropNav = level >= 2;
  const showLinks = level <= 1;
  const out = [];
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';
  const tagRe = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let last = 0;
  let pre = 0;
  const linkStack = [];
  let m;
  const emit = (s) => out.push(s);
  while ((m = tagRe.exec(html)) !== null) {
    if (m.index > last) text(html.slice(last, m.index));
    last = tagRe.lastIndex;
    if (!m[2]) continue; // comment, doctype, processing instruction
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = m[3] ?? '';
    if (!closing && name === 'title') {
      // Already read above. Skip its text.
      const end = findClose('title', last);
      tagRe.lastIndex = last = end === -1 ? html.length : skipPast(end);
      continue;
    }
    if (!closing && (SKIP.has(name) || (dropNav && (name === 'nav' || name === 'footer' || name === 'aside')) || /\shidden(?:\s|=|$)|aria-hidden\s*=\s*["']?true/i.test(attrs))) {
      if (VOID.has(name) || m[4] === '/') continue;
      tagRe.lastIndex = last = skipElement(name, last);
      continue;
    }
    if (/^h[1-6]$/.test(name)) {
      emit(closing ? '\n' : `\n${'#'.repeat(Number(name[1]))} `);
      continue;
    }
    switch (name) {
      case 'br':
        emit('\n');
        break;
      case 'hr':
        emit('\n---\n');
        break;
      case 'li':
        if (!closing) emit('\n- ');
        break;
      case 'tr':
        if (!closing) emit('\n');
        break;
      case 'td':
      case 'th':
        if (!closing) emit(' | ');
        break;
      case 'img': {
        const alt = attr(attrs, 'alt');
        if (alt) emit(` [image ${alt}] `);
        break;
      }
      case 'a':
        if (!closing) linkStack.push({ href: attr(attrs, 'href'), at: out.length });
        else {
          const l = linkStack.pop();
          if (l && showLinks && l.href && !/^(?:#|javascript:|mailto:$)/i.test(l.href)) {
            const inner = out.slice(l.at).join('').trim();
            if (inner && inner !== l.href) emit(` (${l.href})`);
          }
        }
        break;
      case 'pre':
        pre += closing ? -1 : 1;
        if (pre < 0) pre = 0;
        emit('\n');
        break;
      default:
        if (BLOCK.has(name)) emit('\n');
    }
  }
  if (last < html.length) text(html.slice(last));

  const body = out
    .join('')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .map((l) => l.replace(/^\| /, '').replace(/ \|$/, ''))
    .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim();
  return title ? `${title}\n\n${body}` : body;

  function text(s) {
    const decoded = decodeEntities(s);
    emit(pre ? decoded : decoded.replace(/\s+/g, ' '));
  }
  // Case insensitive search for a closing tag without lower casing the whole document, since
  // lower casing can change string length and shift offsets.
  function findClose(name, from) {
    const re = new RegExp(`</${name}`, 'gi');
    re.lastIndex = from;
    const r = re.exec(html);
    return r ? r.index : -1;
  }
  function skipPast(pos) {
    const close = html.indexOf('>', pos);
    return close === -1 ? html.length : close + 1;
  }
  function skipElement(name, from) {
    const raw = name === 'script' || name === 'style' || name === 'textarea' || name === 'template';
    if (raw) {
      const end = findClose(name, from);
      return end === -1 ? html.length : skipPast(end);
    }
    // Count nesting of the same element name.
    const re = new RegExp(`<(/?)${name}(?=[\\s/>])[^>]*>`, 'gi');
    re.lastIndex = from;
    let depth = 1;
    let t;
    while ((t = re.exec(html)) !== null) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) return re.lastIndex;
    }
    return html.length;
  }
}

export function compressHtml(text, level, ctx) {
  const extracted = htmlToText(text, level);
  const sub = ctx.derive(extracted, 'text');
  return compressText(extracted, level, sub);
}
