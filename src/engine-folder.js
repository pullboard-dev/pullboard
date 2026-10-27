/** Keep engine identities outside moving cells until per-package engines are decided [C7]. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { posix } from 'node:path';
import { lex } from './js-lex.js';

/** Read variable binding patterns, skipping initializer expressions so references remain allowed. */
function engineBindings(code) {
  const tokens = [...code.matchAll(/"[^"]*"|'[^']*'|[\p{ID_Start}_$][\p{ID_Continue}$]*|[0-9][\w.]*|\.\.\.|[^\s]/gu)];
  const found = new Map();
  /** Skip an expression through its next declaration or binding separator. */
  function expression(at, ends) {
    const stack = [];
    for (; at < tokens.length; at++) {
      const word = tokens[at][0];
      if (!stack.length && ends.includes(word)) break;
      if ('([{'.includes(word)) stack.push(word);
      else if (')]}'.includes(word)) { if (!stack.length) break; stack.pop(); }
    }
    return at;
  }
  /** Remember a reserved name only when it is the binding, never an object property key. */
  function name(at) {
    if (/^[A-Z][A-Z0-9_]*_ENGINE$/u.test(tokens[at]?.[0] ?? '')) found.set(tokens[at].index, tokens[at]);
  }
  /** Walk identifiers, arrays and nested object aliases in one binding pattern. */
  function binding(at) {
    if (tokens[at]?.[0] === '...') return binding(at + 1);
    const open = tokens[at]?.[0];
    if (open !== '{' && open !== '[') { name(at); return at + 1; }
    const close = open === '{' ? '}' : ']';
    at++;
    while (at < tokens.length && tokens[at][0] !== close) {
      if (tokens[at][0] === ',') { at++; continue; }
      if (open === '{' && tokens[at][0] !== '...') {
        const key = at;
        at = tokens[at][0] === '[' ? expression(at + 1, [']']) + 1 : at + 1;
        if (tokens[at]?.[0] === ':') at = binding(at + 1);
        else name(key);
      } else at = binding(at);
      if (tokens[at]?.[0] === '=') at = expression(at + 1, [',', close]);
      if (tokens[at]?.[0] === ',') at++;
      else if (tokens[at]?.[0] !== close) break;
    }
    return at + 1;
  }
  for (let at = 0; at < tokens.length; at++) {
    if (!['const', 'let', 'var'].includes(tokens[at][0])) continue;
    let next = at + 1;
    do {
      next = binding(next);
      if (tokens[next]?.[0] === '=') next = expression(next + 1, [',', ';', ')']);
      if (tokens[next]?.[0] !== ',') break;
      next++;
    } while (next < tokens.length);
  }
  return [...found.values()].sort((a, b) => a.index - b.index);
}

/** Find declarations that would split the existing engine folder during a package move. */
export function engineFolderViolations(sources) {
  const problems = [];
  for (const { file, source } of sources) {
    if (!/^(?:src|packages|apps)\//u.test(file)) continue;
    if (/^src\/[^/]+\.[cm]?js$/u.test(file)) continue;
    const { code, strings } = lex(source);
    const literals = new Map(strings.map(literal => [literal.start, literal.text]));
    const declarations = engineBindings(code);
    const declared = new Set(declarations.map(match => match[0]));
    for (const list of code.matchAll(/\bexport\s*\{([^}]*)\}/gu)) {
      const end = list.index + list[0].length;
      const from = /^\s*from\b\s*/u.exec(code.slice(end));
      const target = from ? literals.get(end + from[0].length) : null;
      if (target && /^\.{1,2}\//u.test(target) && !target.includes('\\')
        && /^src\/[^/]+\.[cm]?js$/u.test(posix.normalize(posix.join(posix.dirname(file), target)))) continue;
      for (const entry of list[1].split(',')) {
        const exported = /(?:^|\bas\s+)([A-Z][A-Z0-9_]*_ENGINE)\s*$/u.exec(entry.trim());
        if (!exported || declared.has(exported[1])) continue;
        declarations.push({ 0: exported[1], index: list.index });
        declared.add(exported[1]);
      }
    }
    if (declarations.length) {
      for (const match of declarations) problems.push({ file, line: code.slice(0, match.index).split('\n').length,
        text: `${match[0]} must stay in src/ with the engine leaves; move the feature without its engine declaration` });
    } else if (/-engine\.js$/u.test(file)) {
      problems.push({ file, line: 1, text: 'engine leaves must stay directly in src/; move the feature without its engine leaf' });
    }
  }
  return problems;
}

/** Read only product source trees; fixture text is lexed without running any module. */
export function engineFolderProblems(root) {
  const sources = [];
  const pending = ['src', 'packages', 'apps'].filter(folder => existsSync(join(root, folder)));
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') pending.push(file);
      else if (entry.isFile() && /\.[cm]?js$/u.test(file)) sources.push({ file, source: readFileSync(join(root, file), 'utf8') });
    }
  }
  return engineFolderViolations(sources).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
}
