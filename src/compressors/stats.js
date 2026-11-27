// Value statistics shared by the JSON and CSV compressors. Everything here is computed in code,
// sorted deterministically and formatted with a fixed precision.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function fmtNum(x) {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x)) return String(x);
  return String(Number(x.toPrecision(6)));
}

function byCountThenValue(a, b) {
  return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

// Summarise a list of JavaScript values (from JSON). Returns a short phrase.
export function describeValues(values, opts = {}) {
  const top = opts.top ?? 5;
  const n = values.length;
  let nulls = 0;
  let missing = 0;
  const nums = [];
  let ints = true;
  const strs = new Map();
  let strCount = 0;
  let minLen = Infinity;
  let maxLen = 0;
  let t = 0;
  let f = 0;
  let objects = 0;
  let arrays = 0;
  const arrayItems = [];
  let minArr = Infinity;
  let maxArr = 0;
  for (const v of values) {
    if (v === undefined) missing++;
    else if (v === null) nulls++;
    else if (typeof v === 'number') {
      nums.push(v);
      if (!Number.isInteger(v)) ints = false;
    } else if (typeof v === 'string') {
      strCount++;
      strs.set(v, (strs.get(v) ?? 0) + 1);
      if (v.length < minLen) minLen = v.length;
      if (v.length > maxLen) maxLen = v.length;
    } else if (typeof v === 'boolean') {
      if (v) t++;
      else f++;
    } else if (Array.isArray(v)) {
      arrays++;
      for (const x of v) if (x === null || typeof x !== 'object') arrayItems.push(x);
      if (v.length < minArr) minArr = v.length;
      if (v.length > maxArr) maxArr = v.length;
    } else objects++;
  }
  const parts = [];
  if (nums.length) parts.push(numberPhrase(nums, ints));
  if (strCount) {
    const keys = [...strs.keys()];
    if (keys.every((k) => ISO_DATE.test(k))) {
      keys.sort();
      parts.push(`date ${keys[0]}..${keys[keys.length - 1]}`);
    } else parts.push(stringPhrase(strs, strCount, minLen, maxLen, top));
  }
  if (t + f) parts.push(`bool true ${t} false ${f}`);
  if (arrays) {
    const inner = arrayItems.length && opts.nested !== false ? ` of ${describeValues(arrayItems, { top, nested: false })}` : '';
    parts.push(`array len ${minArr}-${maxArr}${inner}`);
  }
  if (objects) parts.push('object');
  if (nulls) parts.push(`null ${nulls}`);
  if (missing) parts.push(`missing ${missing}`);
  if (parts.length === 0) return n === 0 ? 'empty' : 'unknown';
  return parts.join(', ');
}

export function numberPhrase(nums, ints) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const x of nums) {
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
  }
  const unique = new Set(nums).size === nums.length && nums.length > 1 ? ' unique' : '';
  const mean = nums.length > 1 ? ` mean ${fmtNum(sum / nums.length)}` : '';
  return `${ints ? 'int' : 'number'} ${fmtNum(min)}..${fmtNum(max)}${mean}${unique}`;
}

export function stringPhrase(counts, total, minLen, maxLen, top) {
  const distinct = counts.size;
  if (distinct <= top) {
    const list = [...counts.entries()].sort(byCountThenValue).map(([v, c]) => `${shortValue(v)} ${c}`);
    return `str ${list.join(' ')}`;
  }
  if (distinct === total && total > 1) return `str unique, len ${minLen}-${maxLen}`;
  const common = [...counts.entries()].sort(byCountThenValue).slice(0, 3);
  const repeated = common.filter(([, c]) => c > 1).map(([v, c]) => `${shortValue(v)} ${c}`);
  const tail = repeated.length ? `, top ${repeated.join(' ')}` : '';
  return `str ${distinct} distinct, len ${minLen}-${maxLen}${tail}`;
}

function shortValue(v) {
  // Single quotes keep the phrase readable when it is embedded in a JSON string.
  const s = (v.length > 24 ? `${v.slice(0, 21)}...` : v).replace(/[\r\n\t]/g, ' ');
  return `'${s}'`;
}
