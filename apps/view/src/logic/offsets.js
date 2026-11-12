/** Compile-only lexical binding checks for view purity [N26,C7]. */
import { lex } from '../../../../packages/kernel/browser.js';

/** Locate free window reads in compiled source; lexical bindings never authorize another scope. */
export function freeWindowOffsets(source) {
  const { code } = lex(source);
  const tokens = [...code.matchAll(/[A-Za-z_$][\w$]*|=>|\.\.\.|[{}()[\],;=:.*]/gu)]
    .map(match => ({ value: match[0], at: match.index }));
  const pairs = new Map(), stack = [], names = new Set();
  for (const [index, token] of tokens.entries()) {
    if ('([{'.includes(token.value)) stack.push(index);
    else if (')]}'.includes(token.value)) {
      const opening = stack.pop();
      if (opening !== undefined) { pairs.set(opening, index); pairs.set(index, opening); }
    }
  }
  const scopes = [{ start: 0, end: tokens.length, function: true, bound: false }];
  for (const [index, token] of tokens.entries()) if (token.value === '{' && pairs.has(index)) {
    scopes.push({ start: index, end: pairs.get(index), function: false, bound: false });
  }
  /** Split only at this pattern's own separators, preserving nested defaults and destructuring. */
  function parts(start, end, separator = ',') {
    const result = [];
    let from = start;
    for (let index = start; index < end; index++) {
      if ('([{'.includes(tokens[index].value) && pairs.get(index) < end) { index = pairs.get(index); continue; }
      if (tokens[index].value === separator) { result.push([from, index]); from = index + 1; }
    }
    result.push([from, end]);
    return result;
  }
  /** Identify binding positions, excluding property keys and initializer expressions. */
  function binds(start, end) {
    if (tokens[start]?.value === '...') start++;
    if (start >= end) return false;
    end = parts(start, end, '=')[0][1];
    const first = tokens[start].value;
    if (first === '{' || first === '[') return parts(start + 1, Math.min(end, pairs.get(start))).some(([from, to]) => {
      const colon = first === '{' ? parts(from, to, ':') : [];
      return colon.length > 1 ? binds(colon[1][0], to) : binds(from, to);
    });
    return first === 'window';
  }
  /** Cover an arrow or loop statement through its balanced body, without leaking past it. */
  function expressionEnd(start) {
    if (tokens[start]?.value === '{') return pairs.get(start);
    let index = start;
    for (; index < tokens.length; index++) {
      const value = tokens[index].value;
      if ('([{'.includes(value) && pairs.has(index)) { index = pairs.get(index); continue; }
      if ([',', ';', ')', ']', '}'].includes(value)) break;
    }
    return index - 1;
  }
  for (const [index, token] of tokens.entries()) {
    if (token.value === ')' && tokens[index + 1]?.value === '{') {
      const opening = pairs.get(index), before = tokens[opening - 1]?.value;
      if (!['if', 'for', 'while', 'switch', 'with'].includes(before)) scopes.push({
        start: opening, end: pairs.get(index + 1), function: before !== 'catch',
        bound: parts(opening + 1, index).some(([from, to]) => binds(from, to)),
      });
    }
    if (token.value === '=>') {
      const opening = tokens[index - 1]?.value === ')' ? pairs.get(index - 1) : index - 1;
      scopes.push({ start: opening, end: expressionEnd(index + 1), function: true,
        bound: tokens[opening]?.value === '(' ? parts(opening + 1, index - 1).some(([from, to]) => binds(from, to)) : binds(opening, index) });
    }
    if (token.value === 'for' && tokens[index + 1]?.value === '(') scopes.push({
      start: index + 1, end: expressionEnd(pairs.get(index + 1) + 1), function: false, bound: false,
    });
  }
  /** Choose the declaration's actual lexical scope, or its function scope for var. */
  function scopeAt(index, functionOnly = false) {
    return scopes.filter(scope => scope.start <= index && scope.end >= index && (!functionOnly || scope.function))
      .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
  }
  for (const [index, token] of tokens.entries()) {
    if (['const', 'let', 'var'].includes(token.value)) {
      let end = index + 1;
      for (; end < tokens.length; end++) {
        if ('([{'.includes(tokens[end].value) && pairs.has(end)) { end = pairs.get(end); continue; }
        if ([';', ')', 'in', 'of'].includes(tokens[end].value)) break;
      }
      if (parts(index + 1, end).some(([from, to]) => binds(from, to))) scopeAt(index, token.value === 'var').bound = true;
    }
    if (['function', 'class'].includes(token.value)) {
      const name = index + (tokens[index + 1]?.value === '*' ? 2 : 1);
      if (tokens[name]?.value === 'window') {
        names.add(name);
        if (!['=', '(', ',', ':', 'return'].includes(tokens[index - 1]?.value)) scopeAt(index).bound = true;
        const own = scopes.find(scope => scope.start === name + 1);
        if (own) own.bound = true;
      }
    }
    if (token.value === 'import') {
      let end = index + 1;
      while (end < tokens.length && !['from', ';'].includes(tokens[end].value)) end++;
      if (tokens.slice(index + 1, end).some((part, offset) => part.value === 'window'
        && (offset === 0 || tokens[index + offset]?.value === 'as' || tokens[index + offset + 2]?.value !== 'as'))) scopes[0].bound = true;
      for (let name = index + 1; name < end; name++) if (tokens[name].value === 'window') names.add(name);
    }
  }
  const free = new Set();
  for (const [index, token] of tokens.entries()) {
    if (token.value !== 'window' || names.has(index)) continue;
    const before = tokens[index - 1]?.value, after = tokens[index + 1]?.value;
    const method = after === '(' && tokens[pairs.get(index + 1) + 1]?.value === '{';
    if (before === '.' || (after === ':' && ['{', ','].includes(before)) || method) continue;
    if (!scopes.some(scope => scope.bound && scope.start <= index && scope.end >= index)) free.add(token.at);
  }
  return free;
}

