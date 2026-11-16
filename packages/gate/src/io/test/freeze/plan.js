/** Plan the journey-cut freeze from the manifest's tags, purely: what moves, what is converted, what is deleted [C7]. */
import { posix } from 'node:path';

export const FREEZE_ACTIONS = ['delete', 'move', 'convert', 'in place', 'refused'];

const CELL_TESTS = /^((?:packages|apps)\/[^/]+)\/tests?\//u;
const JOURNEYS = /^((?:packages|apps)\/[^/]+)\/journeys\/(.*)$/u;
const ROOT_TEST = /^tests?\/(.*)$/u;
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\n]*|\.{1,2})\2/gu;

/**
 * The files that cover a journey tagged delete: for each spec id it cites, a non-journey test that cites the same id.
 * Why: a journey is deleted only when the manifest names a covering test, so the covering files are the proof recorded with the deletion.
 *
 * @param {object} row manifest row of the journey
 * @param {object[]} rows every manifest row
 * @returns {{ coveredBy: string[], missing: string[] }} covering files, and the spec ids nothing covers
 */
export function coverageOf(row, rows) {
  const covers = new Set(), missing = [];
  const listed = Array.isArray(row.coveredBy) ? row.coveredBy : null;
  for (const id of row.specs ?? []) {
    const found = rows.filter(other => other.file !== row.file && other.kind !== 'journey' && other.tag !== 'delete' && other.specs?.includes(id)
      && (!listed || listed.includes(other.file)));
    if (found.length) for (const other of found) covers.add(other.file);
    else missing.push(id);
  }
  return { coveredBy: [...covers].sort(), missing };
}

/**
 * Where a kept or converted file goes: its owning cell's tests folder.
 * Why: per-cell reuse only scopes tests that live in a cell, so a journey moves beside the cell that owns it, keeping the path under journeys/ so names never collide.
 *
 * @param {string} file current path
 * @param {string|null} cell owning cell folder (packages/<name> or apps/<name>), or null when unknown
 * @returns {string|null} the new path, or null when no owner is known
 */
export function destinationOf(file, cell) {
  if (!cell) return null;
  if (CELL_TESTS.exec(file)?.[1] === cell) return file;
  const journey = JOURNEYS.exec(file);
  if (journey) return `${cell}/tests/journeys/${journey[2]}`;
  const root = ROOT_TEST.exec(file);
  if (root) return `${cell}/tests/${root[1]}`;
  return `${cell}/tests/${posix.basename(file)}`;
}

/**
 * The planned changes, one per manifest row that carries a tag.
 * Why: one pure plan feeds the dry run and the real run alike, so what was printed is what happens.
 *
 * @param {object[]} rows manifest rows (kind, specs, tag, tagBecause)
 * @param {{ owner: (file: string, row: object) => string|null, taken?: Set<string> }} options owner resolver; paths already in use
 * @returns {{ action: string, file: string, to?: string, tag: string, because: string, coveredBy?: string[], specs?: string[] }[]} the plan, sorted by file
 */
export function planFreeze(rows, { owner, taken = new Set() }) {
  const claimed = new Set(taken);
  const plan = [];
  for (const row of rows.filter(entry => entry.tag).sort((a, b) => (a.file < b.file ? -1 : 1))) {
    const base = { file: row.file, tag: row.tag, because: row.tagBecause ?? '' };
    if (row.tag === 'delete') {
      const { coveredBy, missing } = coverageOf(row, rows);
      if (!row.specs?.length || missing.length || !coveredBy.length) {
        plan.push({ ...base, action: 'refused', because: `delete needs a covering test the manifest names; ${row.specs?.length ? `no test covers ${missing.join(', ')}` : 'the file cites no spec id'}` });
      } else plan.push({ ...base, action: 'delete', coveredBy, specs: row.specs });
      continue;
    }
    const to = destinationOf(row.file, owner(row.file, row));
    if (!to) plan.push({ ...base, action: 'refused', because: 'no owning cell is known for this file' });
    else if (to === row.file) plan.push({ ...base, action: 'in place', to });
    else if (claimed.has(to)) plan.push({ ...base, action: 'refused', because: `${to} is already taken` });
    else { claimed.add(to); plan.push({ ...base, action: row.tag === 'convert' ? 'convert' : 'move', to }); }
  }
  return plan;
}

/** The count of each action in a plan, every action listed even at zero. */
export function countActions(plan) {
  return Object.fromEntries(FREEZE_ACTIONS.map(action => [action, plan.filter(change => change.action === action).length]));
}

/**
 * Rewrite a moved file's relative import specifiers so they still reach the same targets.
 * Why: a moved test keeps working only if its imports resolve from the new folder.
 *
 * @param {string} source file text
 * @param {string} from old path
 * @param {string} to new path
 * @returns {string} the text with relative specifiers rebased
 */
export function rebaseSpecifiers(source, from, to) {
  const fromDir = posix.dirname(from), toDir = posix.dirname(to);
  if (fromDir === toDir) return source;
  return source.replace(SPECIFIER, (all, lead, quote, spec) => {
    let next = posix.relative(toDir, posix.join(fromDir, spec));
    if (!next.startsWith('.')) next = `./${next}`;
    return `${lead}${quote}${next}${quote}`;
  });
}
