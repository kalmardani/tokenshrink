// JSON parser that keeps the source offsets of every node, so a compressed rendering can point
// at the exact original characters it left out. Raw text of strings and numbers is kept so
// samples are reproduced exactly as they were written.

const MAX_DEPTH = 512;

export function parseJsonWithOffsets(src) {
  let i = 0;
  let depth = 0;
  if (src.charCodeAt(0) === 0xfeff) i = 1;
  ws();
  const root = value();
  ws();
  if (i !== src.length) fail('unexpected trailing content');
  return root;

  function fail(msg) {
    throw new SyntaxError(`${msg} at offset ${i}`);
  }
  function ws() {
    for (;;) {
      const c = src.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) i++;
      else return;
    }
  }
  function value() {
    const c = src[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"') return string();
    if (c === 't') return literal('true', true);
    if (c === 'f') return literal('false', false);
    if (c === 'n') return literal('null', null);
    return number();
  }
  function literal(word, v) {
    if (!src.startsWith(word, i)) fail('invalid literal');
    const start = i;
    i += word.length;
    return { kind: v === null ? 'null' : 'bool', start, end: i, raw: word, value: v };
  }
  function number() {
    const re = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m || m[0].length === 0) fail('unexpected character');
    const start = i;
    i += m[0].length;
    return { kind: 'number', start, end: i, raw: m[0], value: Number(m[0]) };
  }
  function string() {
    const start = i;
    i++;
    for (;;) {
      const c = src.charCodeAt(i);
      if (Number.isNaN(c)) fail('unterminated string');
      if (c === 34) break;
      if (c === 92) i += 2;
      else if (c < 32) fail('control character in string');
      else i++;
    }
    i++;
    const raw = src.slice(start, i);
    return { kind: 'string', start, end: i, raw, value: JSON.parse(raw) };
  }
  function array() {
    const start = i;
    if (++depth > MAX_DEPTH) fail('nesting too deep');
    i++;
    const items = [];
    ws();
    if (src[i] === ']') {
      i++;
      depth--;
      return { kind: 'array', start, end: i, items };
    }
    for (;;) {
      ws();
      items.push(value());
      ws();
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (src[i] === ']') {
        i++;
        break;
      }
      fail('expected , or ]');
    }
    depth--;
    return { kind: 'array', start, end: i, items };
  }
  function object() {
    const start = i;
    if (++depth > MAX_DEPTH) fail('nesting too deep');
    i++;
    const entries = [];
    ws();
    if (src[i] === '}') {
      i++;
      depth--;
      return { kind: 'object', start, end: i, entries };
    }
    for (;;) {
      ws();
      if (src[i] !== '"') fail('expected key');
      const key = string();
      ws();
      if (src[i] !== ':') fail('expected :');
      i++;
      ws();
      const val = value();
      entries.push({ key: key.value, keyRaw: key.raw, start: key.start, value: val });
      ws();
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (src[i] === '}') {
        i++;
        break;
      }
      fail('expected , or }');
    }
    depth--;
    return { kind: 'object', start, end: i, entries };
  }
}
