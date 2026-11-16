/** Rewrite the path math a moved test computes from its own location, or name the line that cannot be rewritten [C7]. */
import { posix } from 'node:path';

const BASE = String.raw`(?:(?:path\.)?dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)|import\.meta\.dirname)`;
const DECLARATION = new RegExp(String.raw`\b(?:const|let|var)\s+(\w+)\s*=\s*(${BASE})\s*;?`, 'gu');
const URL_MATH = /new\s+URL\(\s*(['"])([^'"\n]*)\1\s*,\s*import\.meta\.url\s*\)/gu;
const JOIN_OPEN = /(?:\bpath\.)?\b(?:join|resolve)\(\s*$/u;
const LITERAL_ARGS = /^((?:\s*,\s*(['"])[^'"\n$\\]*\2)*)\s*\)/u;
const LEFTOVER = /import\.meta\.(?:url|dirname|filename)|\b__filename\b/gu;

/** The line number of an index in a text. */
const lineAt = (text, index) => 1 + (text.slice(0, index).match(/\n/gu)?.length ?? 0);

/** A relative path from one folder to a target, written as a string literal body that keeps a trailing slash. */
function relativeTo(toDir, target, slash) {
  let next = posix.relative(toDir, target) || '.';
  if (slash && !next.endsWith('/')) next += '/';
  return next;
}

/**
 * Rebase the path math in a moved test: `new URL('<rel>', import.meta.url)`, and join or resolve calls on `dirname(fileURLToPath(import.meta.url))`, `import.meta.dirname` or `__dirname`.
 * Why: a moved test that reads fixtures by a path computed from its own location breaks after the move, so each such path is rewritten when its target still resolves, and otherwise named by file and line so the move is refused.
 *
 * @param {string} source file text
 * @param {string} from old path, relative to the project root
 * @param {string} to new path, relative to the project root
 * @param {(path: string) => boolean} exists whether a root-relative path is a file or folder after the move
 * @returns {{ source: string, problems: { line: number, because: string }[] }} the rewritten text, and every line that cannot be rewritten
 */
export function rebasePathMath(source, from, to, exists) {
  const fromDir = posix.dirname(from), toDir = posix.dirname(to);
  if (fromDir === toDir) return { source, problems: [] };
  const edits = [], consumed = [], problems = [];
  const problem = (index, because) => { problems.push({ line: lineAt(source, index), because }); return null; };
  const resolves = (index, steps, last) => {
    if (steps.some(step => posix.isAbsolute(step) || /^[a-z][a-z0-9+.-]*:/iu.test(step))) return problem(index, 'the path is absolute or a URL');
    const target = posix.normalize(posix.join(fromDir, ...steps));
    if (target.startsWith('..') || !exists(target.replace(/\/$/u, '') || '.')) return problem(index, `${target} does not resolve after the move`);
    return relativeTo(toDir, target, /\/$/u.test(last ?? ''));
  };
  const quote = text => `'${text}'`;
  for (const hit of source.matchAll(URL_MATH)) {
    consumed.push([hit.index, hit.index + hit[0].length]);
    const next = resolves(hit.index, [hit[2]], hit[2]);
    if (next === null) continue;
    edits.push([hit.index, hit.index + hit[0].length, `new URL(${quote(next.startsWith('.') ? next : `./${next}`)}, import.meta.url)`]);
  }
  const names = new Set(['__dirname']);
  const declarations = [];
  for (const hit of source.matchAll(DECLARATION)) {
    names.add(hit[1]);
    declarations.push([hit.index, hit.index + hit[0].length]);
    consumed.push([hit.index, hit.index + hit[0].length]);
  }
  const user = new RegExp(String.raw`${BASE}|\b(?:${[...names].join('|')})\b`, 'gu');
  for (const hit of source.matchAll(user)) {
    if (declarations.some(([start, end]) => hit.index >= start && hit.index < end)) continue;
    const end = hit.index + hit[0].length;
    consumed.push([hit.index, end]);
    const opened = JOIN_OPEN.test(source.slice(0, hit.index));
    const args = opened ? LITERAL_ARGS.exec(source.slice(end)) : null;
    if (!args) { problem(hit.index, `${hit[0]} is used other than as the first argument of join or resolve with string literals`); continue; }
    const steps = [...args[1].matchAll(/(['"])([^'"\n]*)\1/gu)].map(step => step[2]);
    const next = resolves(hit.index, steps, steps.at(-1));
    if (next !== null) edits.push([end, end + args[1].length, `, ${quote(next)}`]);
  }
  for (const hit of source.matchAll(LEFTOVER)) {
    if (!consumed.some(([start, end]) => hit.index >= start && hit.index < end)) problem(hit.index, `${hit[0]} is used in a way the freeze cannot rewrite`);
  }
  if (problems.length) return { source, problems: problems.sort((a, b) => a.line - b.line) };
  let text = source;
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + replacement + text.slice(end);
  return { source: text, problems: [] };
}
