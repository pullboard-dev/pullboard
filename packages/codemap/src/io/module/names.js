/** The names each module imports and re-exports, read without evaluating it, so a selector can follow one name through a re-exporting door [C7]. */
import { lex } from '../../../../kernel/index.js';
import { compileModules } from './imports.js';

const ID = '[\\p{ID_Start}$_][\\p{ID_Continue}$\\u200c\\u200d]*';
/** One plain name, optionally renamed; anything else in a list is not a plain named binding. */
const ENTRY = new RegExp(`^(${ID})(?:\\s+as\\s+(${ID}))?$`, 'u');
/** An import clause before `from`: an optional default binding, then a braced list or a namespace. */
const IMPORT_CLAUSE = new RegExp(`^(?:(${ID})\\s*(?:,\\s*)?)?(\\{[^}]*\\}|\\*\\s*as\\s+${ID})?\\s*from\\s*(['"])`, 'u');
/** A star re-export, plain or as a namespace. */
const STAR_EXPORT = new RegExp(`^\\*\\s*(as\\s+(?:${ID}|'[^']*'|"[^"]*")\\s*)?from\\s*(['"])`, 'u');
const KEYWORD = /(?<![\p{ID_Continue}$‌‍#])(import|export)(?![\p{ID_Continue}$‌‍])/gu;

/** The quoted literal whose opening quote sits at `at`, read from the source with the lexer's quote positions. */
function literalAt(source, code, at) {
  const close = code.indexOf(code[at], at + 1);
  return close === -1 ? null : source.slice(at, close + 1);
}

/** Split a braced list into entries; a quoted name is kept as its quote so it is reported, not read as a name. */
function entries(code, open, close) {
  return code.slice(open + 1, close).split(',').map((text, index, all) => ({ text: text.trim(), last: index === all.length - 1 }))
    .filter(entry => entry.text || !entry.last).map(entry => entry.text);
}

/**
 * Every import or export declaration of one module, unresolved where it is not a plain named binding. Masked code
 * keeps strings, comments and templates from matching; a quoted name or a broken list is reported, never dropped.
 */
function declarations(source) {
  const { code } = lex(source);
  const rows = [];
  for (const match of code.matchAll(KEYWORD)) {
    const before = code.slice(0, match.index).trimEnd();
    if (before.endsWith('.') && !before.endsWith('...')) continue;
    const after = match.index + match[0].length;
    const at = after + (code.slice(after).length - code.slice(after).trimStart().length);
    const rest = code.slice(at);
    if (match[1] === 'import') {
      if (rest[0] === '.' || rest[0] === ':') continue;
      if (rest[0] === '(') {
        const quote = /^\(\s*(['"])/u.exec(rest);
        const literal = quote ? literalAt(source, code, at + quote[0].length - 1) : null;
        const plain = literal && /^\s*[,)]/u.test(code.slice(at + quote[0].length - 1 + literal.length));
        rows.push({ kind: 'dynamic', literal: plain ? literal : null });
        continue;
      }
      if (rest[0] === '\'' || rest[0] === '"') { rows.push({ kind: 'bare', literal: literalAt(source, code, at) }); continue; }
      const clause = IMPORT_CLAUSE.exec(rest);
      if (!clause || (!clause[1] && !clause[2])) { rows.push({ kind: 'malformed', literal: null }); continue; }
      const literal = literalAt(source, code, at + clause[0].length - 1);
      if (clause[1]) rows.push({ kind: 'default', literal });
      if (clause[2]?.startsWith('*')) rows.push({ kind: 'namespace', literal });
      if (clause[2]?.startsWith('{')) {
        const open = at + rest.indexOf('{');
        rows.push(named('import', entries(code, open, code.indexOf('}', open)), literal));
      }
      continue;
    }
    if (rest[0] === '*') {
      const star = STAR_EXPORT.exec(rest);
      rows.push(star ? { kind: star[1] ? 'namespace-reexport' : 'star-reexport', literal: literalAt(source, code, at + star[0].length - 1) }
        : { kind: 'malformed', literal: null });
      continue;
    }
    if (rest[0] !== '{') continue;
    const close = code.indexOf('}', at);
    if (close === -1) { rows.push({ kind: 'malformed', literal: null }); continue; }
    const tail = code.slice(close + 1);
    const from = /^\s*from\s*(['"])/u.exec(tail);
    if (!from) continue;
    rows.push(named('export', entries(code, at, close), literalAt(source, code, close + from[0].length)));
  }
  return rows;
}

/** One braced list as names, or the whole declaration unresolved when an entry is not a plain name. */
function named(kind, list, literal) {
  const parsed = list.map(text => ENTRY.exec(text));
  if (parsed.some(entry => !entry)) return { kind: 'malformed', literal };
  if (!parsed.length) return { kind: 'bare', literal };
  const names = parsed.map(entry => kind === 'import' ? { imported: entry[1], local: entry[2] ?? entry[1] } : { imported: entry[1], exported: entry[2] ?? entry[1] });
  return { kind, literal, names };
}

/**
 * Each module's named imports, its named re-exports, and everything else it imports as unresolved: default,
 * namespace, bare, dynamic and star imports, star re-exports and any list that is not plain names. A module that
 * does not compile reports every declaration unresolved. Why: a selector may narrow a door only by names it can
 * prove, and falls back to the whole door for anything listed here as unresolved.
 *
 * @param {string[]} sources
 * @param {(sources: string[]) => Array<{compiles: boolean, imports: string[]}>} [parse] - Compile-only V8 observations; the shared parse scope by default.
 * @returns {{ imports: { source: string, names: { imported: string, local: string }[] }[], reexports: { source: string, names: { imported: string, exported: string }[] }[], unresolved: { kind: string, source: string | null }[] }[]}
 */
export function namedBindingsIn(sources, parse = compileModules) {
  const scanned = sources.map(declarations);
  const literals = [...new Set(scanned.flat().map(row => row.literal).filter(Boolean))];
  const looks = parse([...sources, ...literals.map(literal => `import ${literal};`)]);
  const decoded = new Map(literals.map((literal, index) => [literal, looks[sources.length + index].imports[0] ?? null]));
  return scanned.map((rows, index) => {
    const result = { imports: [], reexports: [], unresolved: [] };
    const compiles = looks[index].compiles;
    for (const row of rows) {
      const source = row.literal ? decoded.get(row.literal) ?? null : null;
      if (compiles && source !== null && (row.kind === 'import' || row.kind === 'export')) {
        (row.kind === 'import' ? result.imports : result.reexports).push({ source, names: row.names });
      } else result.unresolved.push({ kind: compiles ? row.kind : 'malformed', source });
    }
    if (!compiles && !rows.length) result.unresolved.push({ kind: 'malformed', source: null });
    return result;
  });
}
