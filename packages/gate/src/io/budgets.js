/** Find unexplained wall-clock judgments in test source, without executing it [C7]. */
import { join } from 'node:path';
import { gitExecFileSync } from '../../../git/index.js';
import { fileSystemAdapter } from '../../../fs/index.js';

const fs = fileSystemAdapter();

/** Mask comments and quoted fixture text while retaining exact offsets and comment lines. */
function codeOnly(source) {
  const comments = new Map();
  let code = '', line = 1;
  for (let i = 0; i < source.length;) {
    const start = i, firstLine = line;
    const quote = source[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i++] === quote) break;
      }
    } else if (source.startsWith('//', i)) {
      i = source.indexOf('\n', i);
      if (i < 0) i = source.length;
      comments.set(firstLine, source.slice(start, i));
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      source.slice(start, i).split('\n').forEach((part, offset) => comments.set(firstLine + offset, part));
    } else if (quote === '/' && (/[=(:,!&|?;{}\[]\s*$/u.test(code) || /\breturn\s*$/u.test(code))) {
      let characterClass = false;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') characterClass = true;
        if (source[i] === ']') characterClass = false;
        if (source[i++] === '/' && !characterClass) break;
      }
      while (/[a-z]/iu.test(source[i] ?? '') && i < source.length) i++;
      const skipped = source.slice(start, i);
      const masked = skipped.replace(/[^\n]/gu, ' ');
      code += /\belapsed\b/iu.test(skipped) ? masked.replace(/ {7}/u, 'elapsed') : masked;
      line += skipped.split('\n').length - 1;
      continue;
    } else {
      code += source[i++];
      if (quote === '\n') line++;
      continue;
    }
    const skipped = source.slice(start, i);
    code += skipped.replace(/[^\n]/gu, ' ');
    line += skipped.split('\n').length - 1;
  }
  return { code, comments };
}

/** Read a balanced call or condition, including nested callbacks, from masked source. */
function parenthesized(code, opening) {
  let depth = 0;
  for (let end = opening; end < code.length; end++) {
    if (code[end] === '(') depth++;
    if (code[end] === ')' && --depth === 0) return code.slice(opening, end + 1);
  }
  return code.slice(opening);
}

/** Recognize a direct clock observation or an elapsed-time variable/property. */
function observesTime(expression, aliases) {
  return /\b(?:Date|performance)\s*\.\s*now\s*\(|\bhrtime\s*\(|\b\w*(?:elapsed|duration|wallMs|waitMs|delay)\w*\b(?!\s*\()/iu.test(expression)
    || [...aliases].some(name => new RegExp(`\\b${name}\\b`, 'u').test(expression));
}

/** Recognize elapsed arithmetic using a separately captured clock observation. */
function clockDifference(expression, clocks) {
  return expression.includes('-')
    && [...clocks].some(name => new RegExp(`\\b${name}\\b`, 'u').test(expression));
}

/** Split a call at its own commas, never at a nested assertion, callback or argument. */
function argumentsOf(call) {
  const args = [];
  let depth = 0, start = 1;
  for (let i = 1; i < call.length - 1; i++) {
    if ('([{'.includes(call[i])) depth++;
    if (')]}'.includes(call[i])) depth--;
    if (call[i] === ',' && depth === 0) { args.push(call.slice(start, i)); start = i + 1; }
  }
  args.push(call.slice(start, -1));
  return args;
}

/** Recognize literal arguments of wait helpers without crossing their closing parenthesis. */
function literalWait(expression, literals) {
  for (const match of expression.matchAll(/\b(?:\w*wait\w*|event|\w*ClosesWithin|\w*Healthy|\w*Ready)\s*\(/giu)) {
    const call = parenthesized(expression, match.index + match[0].lastIndexOf('('));
    if (argumentsOf(call).some(arg => /^\s*[1-9][0-9_]*\s*$/u.test(arg) || literals.has(arg.trim()))) return true;
  }
  return false;
}

/** Recognize tracked wait-result references while excluding property names and object keys. */
function judgesWaitResult(expression, waitResults) {
  const values = expression.replace(/\.\s*\w+/gu, ' ').replace(/([{,]\s*)\w+\s*:/gu, '$1 ');
  return [...values.matchAll(/\b\w+\b/gu)].some(match => waitResults.has(match[0]));
}

/** Find every literal timing judgment and return its original file, line and source text. */
export function fixedWallMargins(source, file) {
  const { code, comments } = codeOnly(source);
  const lines = source.split('\n');
  const aliases = new Set(), literals = new Set(), clocks = new Set(), waitResults = new Set();
  const declarations = [...code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]+)/gu)];
  for (const match of declarations) {
    if (/^\s*[1-9][0-9_]*\s*$/u.test(match[2])) literals.add(match[1]);
    if (/^\s*(?:Date|performance)\s*\.\s*now\s*\(/u.test(match[2])) clocks.add(match[1]);
  }
  for (const match of declarations) {
    if (observesTime(match[2], aliases) && /\b(?:Date|performance)\s*\.\s*now\s*\([^)]*\)\s*-/u.test(match[2])
      || clockDifference(match[2], clocks)) aliases.add(match[1]);
    const waited = /^\s*await\s+(?:\w+\s*\.\s*)*(\w+)\s*\(/u.exec(match[2])?.[1];
    if (waited && /^(?:\w*wait\w*|event|\w*ClosesWithin|\w*Healthy|\w*Ready)$/iu.test(waited)
      && literalWait(match[2], literals)) waitResults.add(match[1]);
  }
  const found = new Map();
  /** Require a same-line reason, including an explicit approved-spec promise that cannot be relaxed. */
  function record(offset, reason) {
    const line = code.slice(0, offset).split('\n').length;
    if (/\bbudget:\s*[^\n]*(?:measur|baseline|deriv|declared|hang|ceiling|approved row [A-Z]\d|after\s+[1-9][0-9,_]*\s*ms)[^\n]*\S/iu.test(comments.get(line) ?? '')) return;
    found.set(line, `${file}:${line}: ${reason}: ${lines[line - 1].trim()}`);
  }
  const literal = '(?:[1-9][0-9_]*(?:\\.[0-9_]+)?)';
  const margin = new RegExp(`(?:[<>]=?\\s*${literal}\\b|\\b${literal}\\s*[<>]=?)`, 'u');
  for (const match of code.matchAll(/\bassert(?:\s*\.\s*(\w+))?\s*\(/gu)) {
    const call = parenthesized(code, match.index + match[0].lastIndexOf('('));
    const args = argumentsOf(call), expression = args[0];
    const judged = /^(?:equal|notEqual|strictEqual|notStrictEqual|deepEqual|notDeepEqual|deepStrictEqual|notDeepStrictEqual|partialDeepStrictEqual)$/u.test(match[1] ?? '')
      ? args.slice(0, 2) : args.slice(0, 1);
    for (let index = 0; index < judged.length; index++) {
      const argument = judged[index];
      const fixedAlias = [...literals].some(name => new RegExp(`[<>]=?\\s*${name}\\s*$|^\\s*${name}\\s*[<>]=?`, 'u').test(argument));
      const literalPeer = /^(equal|strictEqual)$/u.test(match[1] ?? '')
        && new RegExp(`^\\s*${literal}\\s*$`, 'u').test(judged[1 - index] ?? '');
      if ((observesTime(argument, aliases) || clockDifference(argument, clocks)) && (margin.test(argument) || fixedAlias || literalPeer)) {
        record(match.index, 'literal elapsed-time margin');
      }
    }
    if (judged.some(argument => judgesWaitResult(argument, waitResults))) record(match.index, 'literal wait result judged by an assertion');
    if ((['rejects', 'doesNotReject'].includes(match[1]) || /\bawait\s+/u.test(expression)) && literalWait(expression, literals)) record(match.index, 'literal wait judged by an assertion');
  }
  for (const match of code.matchAll(/\bawait\s+(?:\w+\s*\.\s*)*\w*waitFor\w*\s*\(/giu)) {
    const call = parenthesized(code, match.index + match[0].lastIndexOf('('));
    if (literalWait(match[0] + call.slice(1), literals)) record(match.index, 'literal awaited wait can fail the test');
  }
  for (const match of code.matchAll(/\bsetTimeout\s*\(/gu)) {
    const call = parenthesized(code, match.index + match[0].lastIndexOf('('));
    if (/\b(?:reject|throw|fail\w*)\b/iu.test(call) && /,\s*[1-9][0-9_]*\s*\)$/u.test(call)) record(match.index, 'literal timeout reports failure');
  }
  for (const match of code.matchAll(/\bif\s*\(/gu)) {
    const opening = match.index + match[0].lastIndexOf('(');
    const call = parenthesized(code, opening);
    const following = code.slice(opening + call.length, opening + call.length + 100);
    if (/\bawait\s+/u.test(call) && literalWait(call, literals)
      && /\b(?:throw|return\s+(?:false|null))\b/u.test(following)) record(match.index, 'literal wait reports failure');
  }
  return [...found.values()];
}

/** Scan every tracked test file under a checkout, including nested and documentation tests. */
export function wallClockViolations(root) {
  const found = [];
  const tracked = gitExecFileSync(['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of tracked) {
    const parts = file.split('/');
    const name = parts.at(-1);
    const underTestDirectory = parts.slice(0, -1).includes('test');
    if (parts.some(part => ['.git', 'node_modules', 'work'].includes(part)) || !/\.[cm]?js$/u.test(name)
      || (!underTestDirectory && !/^(?:test|test[-_.].+|.+[-_.]test)\.[cm]?js$/u.test(name))) continue;
    let path = root;
    let regularFile = true;
    for (const [index, part] of parts.entries()) {
      path = join(path, part);
      if (!fs.exists(path)) { regularFile = false; break; }
      const entry = fs.lstat(path);
      if (index < parts.length - 1 ? !entry.isDirectory() : !entry.isFile()) { regularFile = false; break; }
    }
    if (regularFile) found.push(...fixedWallMargins(fs.readFile(path, 'utf8'), file));
  }
  return found.sort();
}
