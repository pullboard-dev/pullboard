/** Prove a source change stays inside static module imports, without evaluating repository code [C7]. */
import { importsIn } from '../../../codemap/light.js';
import * as awaitImportPath from 'node:path';
import { lex } from '../../../kernel/index.js';

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
function importSkeleton(source, spans, maskBindings = true) {
  const edits = spans.flatMap(({ binding, specifier }) => [
    ...(binding && maskBindings ? [{ start: binding.start, end: binding.end, binding: true }] : []),
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

/** True only for static import edits; specifiersOnly also preserves every binding byte. */
export function importOnlyChange(before, after, { specifiersOnly = false } = {}) {
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
      && importSkeleton(before, beforeSpans, !specifiersOnly) === importSkeleton(after, afterSpans, !specifiersOnly);
  } catch {
    return false;
  }
}

/** Prove every cross-lane path edit follows a supplied same-item move or deleted shim [L3]. */
export function movedImportOnlyChange(before, after, file, moves) {
  const decode = value => {
    if (typeof value === 'string') return value;
    if (!Buffer.isBuffer(value) || value.includes(0)) return null;
    const text = value.toString('utf8');
    return Buffer.from(text, 'utf8').equals(value) ? text : null;
  };
  before = decode(before); after = decode(after);
  if (before === null || after === null || before === after) return false;
  try {
    importsIn([before, after]);
    const oldSpans = staticImportSpans(before), newSpans = staticImportSpans(after);
    if (!oldSpans || !newSpans || oldSpans.length !== newSpans.length) return false;
    const { posix } = awaitImportPath;
    const edits = [];
    for (let i = 0; i < oldSpans.length; i++) {
      const a = oldSpans[i].specifier, b = newSpans[i].specifier;
      const oldValue = before.slice(a.start + 1, a.end - 1), newValue = after.slice(b.start + 1, b.end - 1);
      if (oldValue === newValue) continue;
      if (!oldValue.startsWith('.') || !newValue.startsWith('.')) return false;
      const oldPath = posix.normalize(posix.join(posix.dirname(file), oldValue));
      const newPath = posix.normalize(posix.join(posix.dirname(file), newValue));
      if (moves.get(oldPath) !== newPath) return false;
      edits.push({ start: a.start + 1, end: a.end - 1, value: newValue });
    }
    let result = before;
    for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
    // Test-input declarations use repository-root paths, and remain otherwise byte identical.
    const annotation = /(@pullboard-test-input[^\r\n*]*)/gu;
    /** Keep annotations only in actual doc comments, never lookalike string literals. */
    const declarations = source => {
      const comments = lex(source).comments;
      return [...source.matchAll(annotation)].filter(row => comments.some(comment =>
        row.index >= comment.start && row.index + row[0].length <= comment.end
        && /^\/\*\*\s*@pullboard-test-input\b/u.test(source.slice(comment.start, comment.end))));
    };
    const oldRows = declarations(result), newRows = declarations(after);
    if (oldRows.length !== newRows.length) return false;
    let inputChanges = 0;
    for (let i = oldRows.length - 1; i >= 0; i--) {
      const oldWords = oldRows[i][0].split(/(\s+)/u), newWords = newRows[i][0].split(/(\s+)/u);
      if (oldWords.length !== newWords.length) return false;
      for (let j = 0; j < oldWords.length; j++) if (oldWords[j] !== newWords[j]) {
        if (moves.get(oldWords[j]) !== newWords[j]) return false;
        inputChanges++;
      }
      result = result.slice(0, oldRows[i].index) + newRows[i][0] + result.slice(oldRows[i].index + oldRows[i][0].length);
    }
    return (edits.length > 0 || inputChanges > 0) && result === after;
  } catch { return false; }
}

/** Collect renames and deleted one-target forwarding shims from a NUL-delimited Git diff [L3]. */
export function movedImportTargets(diff, readBefore, existsAfter) {
  const fields = diff.split('\0'), moves = new Map();
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++], oldPath = fields[i++];
    if (status.startsWith('R')) { moves.set(oldPath, fields[i++]); continue; }
    if (status.startsWith('C')) { i++; continue; }
    if (status !== 'D') continue;
    const bytes = readBefore(oldPath);
    const source = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes;
    if (typeof source !== 'string') continue;
    const match = /^(?:\s*\/\*\*[\s\S]*?\*\/\s*)?export\s*(?:\{[\w$,\s]+\}|\*)\s*from\s*(['"])(\.\.?\/[^'"\n]+)\1\s*;?\s*$/u.exec(source);
    if (!match) continue;
    const target = awaitImportPath.posix.normalize(awaitImportPath.posix.join(awaitImportPath.posix.dirname(oldPath), match[2]));
    if (existsAfter(target)) moves.set(oldPath, target);
  }
  return moves;
}
