/** Prove a fixed string tail using the fixture recognizer's existing lexical spans, never evaluating a prefix [C7]. */

/** Return only a literal tail of an entire string expression; callers separately prove the actual filesystem operation. */
function fixedStringSuffix({ source, code, strings, range, close }) {
  /** Trim only lexical whitespace while retaining the exact original expression bounds. */
  function trim(start, end) {
    while (start < end && /\s/u.test(code[start])) start++;
    while (end > start && /\s/u.test(code[end - 1])) end--;
    return { start, end };
  }
  /** Accept a plain literal token only at the complete supplied operand, with no escape interpretation. */
  function token(span) {
    return strings.find(row => row.start === span.start && row.end === span.end && !row.text.includes('\\'));
  }
  const whole = token(range);
  if (whole && source[whole.start] === '`' && whole.text.includes('${')) {
    return whole.text.slice(whole.text.lastIndexOf('}') + 1);
  }
  for (const literal of strings) {
    if (literal.end !== range.end || source[literal.start] === '`' || literal.text.includes('\\')) continue;
    let plus = literal.start - 1;
    while (plus >= range.start && /\s/u.test(code[plus])) plus--;
    if (plus < range.start || code[plus] !== '+') continue;
    const prefix = trim(range.start, plus), text = code.slice(prefix.start, prefix.end);
    // A complete atom/group forces this plus to be binary, outside any unknown prefix precedence.
    const atom = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*$/u.test(text)
      && !/^(?:await|yield|typeof|void|delete|new|instanceof|in)$/u.test(text);
    const group = code[prefix.start] === '(' && close(prefix.start) === prefix.end - 1;
    if (atom || group) return literal.text;
  }
  return null;
}

/** Keep the theorem at literal string tails, excluding decoding, separators and Unicode boundary/casefold uncertainty. */
export function stringSuffixDisjoint(input, basenames) {
  const suffix = fixedStringSuffix(input);
  return Boolean(suffix && /^[\x21-\x7e]+$/u.test(suffix) && !/[\\/:?#%]/u.test(suffix) && !suffix.endsWith('.')
    && basenames.every(name => /^[\x21-\x7e]+$/u.test(name))
    && !basenames.some(name => name.toLowerCase().endsWith(suffix.toLowerCase())));
}
