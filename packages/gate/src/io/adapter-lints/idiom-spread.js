/**
 * Find a statement shape copied into 3 or more source files with no shared helper, and refuse its spread [C7,#9521].
 * A shape is 3 consecutive code lines with string and number literals blanked, so two copies that differ only in a name string match.
 * Imports, comments and blank lines are skipped, and a window of closing braces or a very short window is not a shape. Named idioms (one-line
 * habits such as a frame callback that sets a timer) are counted by pattern against a ceiling that may only fall.
 *
 * Why: a copied statement shape means a fourth copy is cheaper than the helper nobody wrote, so each copy makes the next likelier. Behind
 * gate.idiomSpread, off by default: with it off the check reads nothing and reports nothing.
 */
/** The ceilings file: per named idiom, the most sites its pattern may match, repo-relative. A ceiling may only fall. */
export const IDIOM_CEILING_FILE = 'packages/gate/data/ceilings/idiom-spread.json';

/** The fewest files that make a copied shape a finding. */
export const SPREAD_FILES = 3;
/** Lines in one shape window: more than 2. */
const WINDOW = 3;
/** A window shorter than this once normalized is too small to be a statement worth sharing. */
const MIN_SHAPE_LENGTH = 60;

const SOURCE_FILE = /^(?:apps\/[^/]+\/src|packages\/[^/]+\/src)\/.*\.[cm]?js$/u;
const TEST_FILE = /(?:^|\/)tests?\/|[-_.]test\.[cm]?js$/u;
const SKIPPED = /^(?:\/\/|\/\*|\*|import\s|export\s.*\sfrom\s)/u;
const ONLY_CLOSERS = /^[\s})\];,]*$/u;

/** Whether a repo-relative path is a source file the check covers: apps and packages source, never a test. */
export const coveredByIdiomSpread = path => SOURCE_FILE.test(path) && !TEST_FILE.test(path);

/**
 * One code line with literals blanked, or null when the line is blank, a comment or an import.
 *
 * @param {string} line - Source line.
 * @returns {string | null} The normalized line.
 */
export function normalizeLine(line) {
  const trimmed = line.trim();
  if (!trimmed || SKIPPED.test(trimmed)) return null;
  return trimmed.replace(/(['"`])(?:\\.|(?!\1).)*\1/gu, 'S').replace(/\b\d+(?:\.\d+)?\b/gu, 'N').replace(/\s+/gu, ' ');
}

/**
 * Every shape window of one file: the first line number of each distinct 3-line shape, in line order.
 *
 * @param {string} source - File text.
 * @returns {Map<string, number>} Shape text to its first line.
 */
export function shapesOf(source) {
  const kept = [];
  source.split('\n').forEach((text, index) => {
    const line = normalizeLine(text);
    if (line !== null) kept.push({ line, number: index + 1 });
  });
  const shapes = new Map();
  for (let at = 0; at + WINDOW <= kept.length; at++) {
    const window = kept.slice(at, at + WINDOW);
    if (window.some(row => ONLY_CLOSERS.test(row.line))) continue;
    const shape = window.map(row => row.line).join('\n');
    if (shape.length < MIN_SHAPE_LENGTH || shapes.has(shape)) continue;
    shapes.set(shape, window[0].number);
  }
  return shapes;
}

/**
 * Findings for shapes found in 3 or more files: one row per file naming where its copy starts. Overlapping windows of one copy report once.
 *
 * @param {Record<string, string>} files - Repo-relative path to text.
 * @returns {string[]} `path:line: ...` rows, sorted.
 */
export function spreadFindings(files) {
  const byShape = new Map();
  for (const [path, source] of Object.entries(files)) {
    if (!coveredByIdiomSpread(path)) continue;
    for (const [shape, line] of shapesOf(source)) byShape.set(shape, [...(byShape.get(shape) ?? []), { path, line }]);
  }
  const hits = new Map();
  for (const [shape, sites] of byShape) {
    if (sites.length < SPREAD_FILES) continue;
    for (const { path, line } of sites) hits.set(path, [...(hits.get(path) ?? []), { line, files: sites.length, first: shape.split('\n')[0] }]);
  }
  const rows = [];
  for (const [path, found] of hits) {
    let last = -Infinity;
    for (const hit of found.sort((a, b) => a.line - b.line)) {
      if (hit.line <= last + 2) { last = hit.line; continue; }
      last = hit.line;
      rows.push(`${path}:${hit.line}: statement shape "${hit.first.slice(0, 60)}" is copied into ${hit.files} files with no shared helper; extract one`);
    }
  }
  return rows.sort();
}

/**
 * Findings for named idioms: an idiom whose pattern matches more sites than its ceiling, in 3 or more files, reports every site.
 *
 * @param {Record<string, string>} files - Repo-relative path to text.
 * @param {Record<string, {pattern: string, sites: number}>} [idioms] - Ceilings by idiom name; a ceiling may only fall.
 * @returns {string[]} `path:line: ...` rows, sorted.
 */
export function idiomFindings(files, idioms = {}) {
  const rows = [];
  for (const [name, { pattern, sites: ceiling }] of Object.entries(idioms)) {
    const matcher = new RegExp(pattern, 'u');
    const found = [];
    for (const [path, source] of Object.entries(files)) {
      if (!coveredByIdiomSpread(path)) continue;
      source.split('\n').forEach((text, index) => { if (!SKIPPED.test(text.trim()) && matcher.test(text)) found.push({ path, line: index + 1 }); });
    }
    if (found.length <= ceiling || new Set(found.map(site => site.path)).size < SPREAD_FILES) continue;
    for (const { path, line } of found) rows.push(`${path}:${line}: idiom ${name} has ${found.length} sites, ceiling ${ceiling}; extract a shared helper, the ceiling only falls`);
  }
  return rows.sort();
}

/**
 * Run the check over the source rows of a checkout. Off (the default) it reports nothing and reads nothing.
 * Why rows and text, not a root: the registry already holds the source texts and reads the ceilings file, so this module imports no file system.
 *
 * @param {{file: string, source: string}[]} rows - Source files of the checkout.
 * @param {{enabled?: boolean, ceilings?: string}} [options] - `enabled` is gate.idiomSpread; `ceilings` is the text of the ceilings file.
 * @returns {string[]} Findings, empty when the setting is off or nothing spreads.
 */
export function idiomSpreadRows(rows, { enabled = false, ceilings = '{}' } = {}) {
  if (enabled !== true) return [];
  let idioms = {};
  try { idioms = JSON.parse(ceilings).idioms ?? {}; } catch { idioms = {}; }
  const files = Object.fromEntries(rows.map(row => [row.file, row.source]));
  return [...spreadFindings(files), ...idiomFindings(files, idioms)].sort();
}
