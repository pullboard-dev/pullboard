/** Read the loader declarations a module states in its leading comment header, without running it [C7,V4]. */
import { posix } from 'node:path';

const MODULE = /\.[cm]?js$/u;
// A computed-import test may declare the repository modules it can load, in its leading comment header only.
const LOADS = /^\/\*\* @pullboard-test-loads (.+?) \*\/$/u;
const SOURCE_LOADS = /^\/\*\* @pullboard-module-loads (.+?) \*\/$/u;

/**
 * The file's leading comment header: its lines before the first line of code. A declaration counts only here, so
 * declaration-looking text inside a string or template later in the file is never read as one (#803).
 */
export function headerLines(source) {
  const lines = [];
  let inBlock = false;
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const text = line.trim();
    if (inBlock) { lines.push(line); if (text.includes('*/')) inBlock = false; continue; }
    if (!text || (index === 0 && text.startsWith('#!')) || text.startsWith('//')) { lines.push(line); continue; }
    if (!text.startsWith('/*')) break;
    lines.push(line);
    inBlock = !text.slice(2).includes('*/');
  }
  return lines;
}

/** Match a declared path glob: * and ? stay within one folder, ** crosses folders; null for other glob syntax. */
export function globPattern(glob) {
  if (/[[\]{}]/u.test(glob)) return null;
  const source = glob.split(/(\*\*\/|\*\*|\*|\?)/u).map(part => part === '**/' ? '(?:.*/)?' : part === '**' ? '.*'
    : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^$()|\\]/gu, '\\$&')).join('');
  return new RegExp(`^${source}$`, 'u');
}

/**
 * The repository modules a computed loader declares in its leading header, with globs expanded over committed
 * modules. Tests retain legacy outside-path filtering; strict source declarations require every target to exist
 * and every glob to match. Invalid declarations return null so unknown imports still require the full suite.
 *
 * @returns {string[] | null}
 */
function declaredPaths(source, declaration, strict) {
  const header = headerLines(source);
  if (strict && header.some(line => line.includes('@pullboard-module-loads') && !declaration.test(line))) return null;
  const declared = header.map(line => declaration.exec(line)).filter(Boolean)
    .flatMap(match => match[1].trim().split(/\s+/u)).map(path => posix.normalize(path));
  if (strict && declared.some(path => path.startsWith('../') || path.startsWith('/'))) return null;
  return declared.filter(path => !path.startsWith('../') && !path.startsWith('/'));
}

/** Expand the same canonical declaration paths over actual committed module identities. */
export function declaredLoads(source, modulePaths, declaration = LOADS, strict = false) {
  const paths = declaredPaths(source, declaration, strict);
  if (paths === null) return null;
  const loads = [];
  for (const path of paths) {
    if (!/[*?[\]{}]/u.test(path)) {
      if (strict && (!MODULE.test(path) || !modulePaths.includes(path))) return null;
      if (MODULE.test(path)) loads.push(path);
      continue;
    }
    const pattern = globPattern(path);
    if (!pattern) return null;
    const matches = modulePaths.filter(module => pattern.test(module));
    if (strict && !matches.length) return null;
    loads.push(...matches);
  }
  return loads;
}

/** Resolve strict source loader declarations; malformed or unmatched declarations remain unknown. */
export function declaredSourceLoads(source, modulePaths) {
  return declaredLoads(source, modulePaths, SOURCE_LOADS, true);
}

/** Return canonical source patterns only after the complete declaration resolves against its actual snapshot. */
export function declaredSourcePatterns(source, modulePaths) {
  return declaredSourceLoads(source, modulePaths) === null ? null : declaredPaths(source, SOURCE_LOADS, true);
}
