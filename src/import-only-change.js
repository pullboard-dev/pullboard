/** Prove a source change stays inside static module imports, without evaluating repository code [C7]. */
import { importsIn } from './module-imports.js';
import { lex } from './js-lex.js';

const IMPORT_WORD = /(?<![\p{ID_Continue}$\u200c\u200d#])import(?![\p{ID_Continue}$\u200c\u200d])/u;
const FROM_WORD = /(?<![\p{ID_Continue}$\u200c\u200d#])from(?![\p{ID_Continue}$\u200c\u200d])/u;

/** Find a string token beginning at one exact source offset. */
function stringAt(strings, offset) {
  return strings.find(string => string.start === offset) ?? null;
}

/** Skip spaces and comments already masked by the shared JavaScript lexer. */
function skipTrivia(code, offset) {
  while (offset < code.length && /\s/u.test(code[offset])) offset += 1;
  return offset;
}

/** Return spans for conservative top-level static imports; unsupported shapes fail closed. */
function staticImportSpans(source) {
  const { code, strings, comments } = lex(source);
  const spans = [];
  let braces = 0, brackets = 0, parentheses = 0;
  for (let at = 0; at < code.length; at += 1) {
    if (braces === 0 && brackets === 0 && parentheses === 0
      && code.startsWith('import', at) && IMPORT_WORD.test(code.slice(Math.max(0, at - 1), at + 7))) {
      const before = at > 0 ? code[at - 1] : '';
      const afterKeyword = skipTrivia(code, at + 6);
      if (before !== '.' && code[afterKeyword] !== '(' && code[afterKeyword] !== '.') {
        const sideEffect = stringAt(strings, afterKeyword);
        let binding = null;
        let specifier = sideEffect;
        if (!sideEffect) {
          let localBraces = 0, localBrackets = 0, localParentheses = 0, fromAt = -1;
          for (let cursor = afterKeyword; cursor < code.length; cursor += 1) {
            const depthZero = localBraces === 0 && localBrackets === 0 && localParentheses === 0;
            if (depthZero && code.startsWith('from', cursor) && FROM_WORD.test(code.slice(Math.max(0, cursor - 1), cursor + 5))) {
              fromAt = cursor;
              break;
            }
            if (code[cursor] === '{') localBraces += 1;
            else if (code[cursor] === '}') localBraces -= 1;
            else if (code[cursor] === '[') localBrackets += 1;
            else if (code[cursor] === ']') localBrackets -= 1;
            else if (code[cursor] === '(') localParentheses += 1;
            else if (code[cursor] === ')') localParentheses -= 1;
          }
          if (fromAt < 0) return null;
          binding = { start: afterKeyword, end: fromAt };
          specifier = stringAt(strings, skipTrivia(code, fromAt + 4));
        }
        if (!specifier) return null;
        if (binding && comments.some(comment => comment.start < binding.end && comment.end > binding.start)) return null;
        spans.push({ binding, specifier });
        at = specifier.end - 1;
        continue;
      }
    }
    if (code[at] === '{') braces += 1;
    else if (code[at] === '}') braces -= 1;
    else if (code[at] === '[') brackets += 1;
    else if (code[at] === ']') brackets -= 1;
    else if (code[at] === '(') parentheses += 1;
    else if (code[at] === ')') parentheses -= 1;
  }
  return spans;
}

/** Blank only bindings and specifier contents while preserving all non-import text and line breaks. */
function importSkeleton(source, spans) {
  const edits = spans.flatMap(({ binding, specifier }) => [
    ...(binding ? [{ start: binding.start, end: binding.end, binding: true }] : []),
    { start: specifier.start + 1, end: specifier.end - 1, binding: false },
  ]).sort((left, right) => left.start - right.start);
  let cursor = 0;
  let result = '';
  for (const edit of edits) {
    if (edit.start < cursor) return null;
    result += source.slice(cursor, edit.start);
    const newlines = edit.binding ? source.slice(edit.start, edit.end).match(/\r\n|\r|\n/gu)?.join('') ?? '' : '';
    result += `\u0001${newlines}`;
    cursor = edit.end;
  }
  return result + source.slice(cursor);
}

/** True only when both valid modules differ inside static import bindings or specifier text. */
export function importOnlyChange(before, after) {
  const decode = value => {
    if (typeof value === 'string') return value;
    if (!Buffer.isBuffer(value) || value.includes(0)) return null;
    const text = value.toString('utf8');
    return Buffer.from(text, 'utf8').equals(value) ? text : null;
  };
  before = decode(before);
  after = decode(after);
  if (typeof before !== 'string' || typeof after !== 'string' || before === after) return false;
  try {
    importsIn([before, after]);
    const beforeSpans = staticImportSpans(before);
    const afterSpans = staticImportSpans(after);
    return beforeSpans !== null && afterSpans !== null
      && importSkeleton(before, beforeSpans) === importSkeleton(after, afterSpans);
  } catch {
    return false;
  }
}
