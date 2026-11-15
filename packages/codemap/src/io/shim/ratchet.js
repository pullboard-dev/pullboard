/** Refuse newly introduced dependencies on compatibility forwards, without executing source [C7,CD64]. */
import { lex } from '../../../../kernel/index.js';
import { Refused } from '../../../../kernel/index.js';
import { repositoryImport } from '../../logic/imports.js';
import { temporaryCellEdges } from '../cell/lint/inventory.js';

/** Capture real module declarations and literal imports at lexer-preserved offsets, not quoted examples. */
function statements(source) {
  const parsed = lex(source), result = [];
  const patterns = [
    /(?<![\w$.])import\s*(?:(?!\()[^;()]*?\bfrom\s*)?(['"])/gu,
    /\bexport\s*(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])/gu,
    /(?<![\w$.])import\s*\(\s*(['"])/gu,
  ];
  for (const pattern of patterns) for (const match of parsed.code.matchAll(pattern)) {
    const literal = parsed.strings.find(row => row.start === match.index + match[0].length - 1);
    if (literal) result.push({ text: source.slice(match.index, literal.end),
      literal: source.slice(literal.start, literal.end), line: source.slice(0, match.index).split('\n').length });
  }
  return result;
}

/** An actual forwarding module is a shim; a still-unmoved implementation is never guessed to be one. */
function forwards(source) {
  const code = lex(source).code.replace(/\s/gu, '');
  return /^(?:export(?:\*(?:as[\w$]+)?|\{[^}]*\})from(?:''|"");?)+$/u.test(code);
}

/**
 * Load only recognized plan shard identities through the caller's immutable source reader.
 * Why: malformed plan JSON at one revision yields no plan here, so a commit carrying it is judged by the other
 * revisions' plans and refused by the planned-source check, rather than crashing the hook with a parse error.
 */
function planAt(read, revision) {
  try { return planRowsAt(read, revision); }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
}

/** Read one revision's plan index and canonical shards; malformed JSON throws SyntaxError to planAt. */
function planRowsAt(read, revision) {
  const raw = read(revision, 'packages/codemap/data/plan/cells.json');
  if (raw === undefined || raw === null) return null;
  const index = JSON.parse(String(raw));
  if (!Array.isArray(index.cells)) throw new Refused('SHIM_IMPORT_PLAN', 'the cells plan must contain its cell rows');
  const cells = index.cells.map(row => {
    if (Array.isArray(row.paths)) return row;
    if (!/^packages\/codemap\/data\/plan\/\d{2,}-[a-z-]+\.json$/u.test(row.file ?? '')) {
      throw new Refused('SHIM_IMPORT_PLAN', 'read only canonical cells plan shard paths');
    }
    const source = read(revision, row.file);
    if (source === undefined || source === null) throw new Refused('SHIM_IMPORT_PLAN', `missing cells plan shard ${row.file}`);
    return JSON.parse(String(source));
  });
  return { ...index, cells };
}

/** Compare declaration multisets, so an unchanged import survives but new bindings and duplicate imports do not. */
export function shimImportProblems({ changes, plans, read, parseImports, criterion = '', now = Date.now() }) {
  const owners = new Map();
  for (const plan of plans.filter(Boolean)) for (const cell of plan.cells) for (const [from, to] of cell.paths ?? []) {
    if (from !== to && !owners.has(from)) owners.set(from, { target: to, frontDoor: cell.frontDoor });
  }
  if (!owners.size) return [];
  if (typeof parseImports !== 'function') throw new Refused('SHIM_IMPORT_PARSER', 'supply the canonical compile-only import parser');
  const rows = changes.filter(row => /\.[cm]?js$/u.test(row.file)).map(row => ({ ...row,
    beforeImports: statements(String(row.before ?? '')), afterImports: statements(String(row.after ?? '')),
    acceptedImports: statements(String(row.accepted ?? '')) }));
  const literals = [...new Set(rows.flatMap(row => [...row.beforeImports, ...row.afterImports, ...row.acceptedImports].map(value => value.literal)))];
  const decoded = parseImports(literals.map(literal => `import ${literal};`));
  const names = new Map(literals.map((literal, index) => [literal, decoded[index]?.[0]]));
  const rawTemporary = read('after', 'packages/codemap/data/plan/temporary-edges.json');
  const temporary = temporaryCellEdges(new Map(rawTemporary == null ? [] : [['packages/codemap/data/plan/temporary-edges.json', Buffer.from(String(rawTemporary))]]), now);
  let imports = {};
  const manifest = read('after', 'package.json');
  if (manifest != null) imports = JSON.parse(String(manifest)).imports ?? {};
  const problems = [], shimCache = new Map();
  for (const row of rows) {
    const counts = new Map();
    for (const list of [row.beforeImports, row.acceptedImports]) {
      const own = new Map();
      for (const entry of list) own.set(entry.text, (own.get(entry.text) ?? 0) + 1);
      for (const [text, count] of own) counts.set(text, Math.max(counts.get(text) ?? 0, count));
    }
    for (const entry of row.afterImports) {
      if ((counts.get(entry.text) ?? 0) > 0) { counts.set(entry.text, counts.get(entry.text) - 1); continue; }
      const name = names.get(entry.literal);
      const target = typeof name === 'string' ? repositoryImport(row.file, name, imports) : null;
      const owner = owners.get(target);
      if (!owner) continue;
      if (!shimCache.has(target)) shimCache.set(target, ['before', 'after'].some(revision => {
        const source = read(revision, target), moved = read(revision, owner.target);
        return source != null && moved != null && forwards(String(source));
      }));
      if (!shimCache.get(target)) continue;
      const allowed = !temporary.problems.length && criterion.includes(`${row.file} -> ${target}`)
        && temporary.edges.some(edge => edge.importer === row.file && edge.target === target);
      if (!allowed) problems.push(`${row.file}:${entry.line}: added import through compatibility shim ${target}; import from ${owner.frontDoor} instead`);
    }
  }
  return problems;
}

/**
 * Whether any changed module declares an import its HEAD or accepted-main text did not already declare, counted as multisets.
 * Why: only an added import can be an import through a shim, so a commit that adds none needs no plan read [C7,H24].
 */
function addsImport(changes) {
  for (const row of changes.filter(change => /\.[cm]?js$/u.test(change.file))) {
    const counts = new Map();
    for (const text of [row.before, row.accepted]) {
      const own = new Map();
      for (const entry of statements(String(text ?? ''))) own.set(entry.text, (own.get(entry.text) ?? 0) + 1);
      for (const [key, count] of own) counts.set(key, Math.max(counts.get(key) ?? 0, count));
    }
    for (const entry of statements(String(row.after ?? ''))) {
      if ((counts.get(entry.text) ?? 0) > 0) counts.set(entry.text, counts.get(entry.text) - 1);
      else return true;
    }
  }
  return false;
}

/** Read the exact staged declarations; neither unstaged fixes nor candidate prose authorize an exception. */
export function stagedShimImportProblems({ paths, read, accepted = 'HEAD', parseImports, criterion = '' }) {
  const changes = paths.filter(file => /\.[cm]?js$/u.test(file))
    .map(file => ({ file, before: read('HEAD', file), after: read(':index', file), accepted: read(accepted, file) }));
  // The cells plan is 50 shards read at three revisions; a commit that adds no import never consults it [C7,H24].
  if (!addsImport(changes)) return [];
  const plans = [planAt(read, accepted), planAt(read, 'HEAD'), planAt(read, ':index')];
  if (!plans.some(Boolean)) return [];
  return shimImportProblems({ plans, parseImports, criterion,
    read: (revision, file) => read(revision === 'before' ? 'HEAD' : ':index', file), changes });
}
