// Fast token estimate. It is a heuristic, not a real tokenizer. It splits the text into
// runs of ASCII letters, digits, other letters, whitespace and single symbols, and charges
// each run roughly what common BPE tokenizers charge for it. The aim is a stable, cheap
// number for budgets and reports. Measured provider token counts are reported by eval.

const RUN = /[A-Za-z]+|[0-9]+|[\p{L}\p{M}]+|[ \t]+|\r?\n[ \t\r\n]*|[^\sA-Za-z0-9\p{L}\p{M}]/gu;
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function estimateTokens(text) {
  if (!text) return 0;
  let n = 0;
  let prevWasSpace = false;
  RUN.lastIndex = 0;
  for (const m of text.matchAll(RUN)) {
    const s = m[0];
    const c = s.charCodeAt(0);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      // A leading single space merges into the word token in BPE vocabularies.
      n += s.length <= 7 ? 1 : Math.ceil(s.length / 6);
    } else if (c >= 48 && c <= 57) {
      n += Math.ceil(s.length / 3);
    } else if (c === 32 || c === 9) {
      if (s.length > 1) n += 1;
      prevWasSpace = true;
      continue;
    } else if (c === 10 || c === 13) {
      n += 1;
    } else if (WIDE.test(s[0])) {
      n += s.length;
    } else if (/[\p{L}\p{M}]/u.test(s[0])) {
      n += Math.ceil(s.length / 2.5);
    } else {
      // A symbol, one token. Non BMP symbols (emoji) usually cost two.
      n += s.length > 1 ? 2 : 1;
    }
    prevWasSpace = false;
  }
  void prevWasSpace;
  return n;
}
