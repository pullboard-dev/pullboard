/**
 * No process is load-bearing [C7]: a static count of detached or long-lived children and of state files written
 * under the board's folder or the OS temp folder, outside the drive, transport, jobs and pin cells. Existing sites
 * sit in a ceiling that only falls; the gate and the pre-commit hook refuse a changed file that grows past it.
 *
 * Why: every activity that takes time is a job row with a lease, and anything derived is a result keyed by content.
 * A process that holds state of its own, or a file only that process understands, dies with the work inside it.
 */
import { lex } from '../../../../kernel/index.js';
import { lineAt } from '../../../../kernel/index.js';

/** The ceilings file, relative to the checkout root. */
export const LOAD_BEARING_CEILINGS = 'packages/gate/data/ceilings/load-bearing.json';

/** The cells allowed to own processes and state files. */
export const LOAD_BEARING_CELLS = Object.freeze(['drive', 'transport', 'jobs', 'pin']);

const OWNED = new RegExp(`^packages/(?:${LOAD_BEARING_CELLS.join('|')})/`, 'u');
const SOURCE = /^(?:src|packages|apps|bin)\/.*\.[cm]?js$/u;
const TEST = /(?:^test\/|\/tests?\/|\.(?:test|spec|fixture)\.[cm]?js$)/u;
const DETACHED = /(?<![\w$])detached\s*:(?!\s*(?:false\b|['"`]))/gu; // a spawn option, not a message keyed by the word
const UNREF = /\.\s*unref\s*\(/gu;
const INTERVAL = /(?<![\w$.])setInterval\s*\(|\.\s*setInterval\s*\(/gu;
const FOREVER = /(?<![\w$])(?:while\s*\(\s*(?:true|1)\s*\)|for\s*\(\s*;\s*;\s*\))\s*\{/gu;
const WRITE = /(?<![\w$])(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|mkdir|mkdtempSync|mkdtemp|renameSync|rename)\s*\(/gu;
const TEMP_ROOT = /(?<![\w$])tmpdir\s*\(/u;

const MESSAGES = {
  detached: 'starts a detached child process',
  unref: 'unrefs a child or timer so it outlives its caller',
  'daemon-loop': 'runs a loop that never ends on its own (setInterval, while (true) or for (;;) with an await)',
  'state-file': 'writes a file in a module that names .git/pullboard or the OS temp folder',
};

/**
 * Whether a repo-relative path is judged: a source file outside tests and outside the four owning cells.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function loadBearingJudged(path) {
  return SOURCE.test(path) && !TEST.test(path) && !OWNED.test(path);
}

/**
 * The offset of the brace that closes the block opened at `open`, in lexed code, or the end of the code.
 *
 * @param {string} code
 * @param {number} open
 * @returns {number}
 */
function blockEnd(code, open) {
  let depth = 0;
  for (let at = open; at < code.length; at++) {
    if (code[at] === '{') depth++;
    else if (code[at] === '}' && --depth === 0) return at;
  }
  return code.length;
}

/**
 * Whether the module names a state root: the board folder (`'.git/pullboard…'`, or `'pullboard'` as a later path
 * segment of a join) or the OS temp folder (`tmpdir()`).
 *
 * @param {string} code - Lexed code with strings blanked.
 * @param {{ start: number, text: string }[]} strings
 * @returns {boolean}
 */
function namesStateRoot(code, strings) {
  if (TEMP_ROOT.test(code)) return true;
  return strings.some(literal => /^\.git\/pullboard(?:\/|$)/u.test(literal.text)
    || (literal.text === 'pullboard' && /,\s*$/u.test(code.slice(Math.max(0, literal.start - 40), literal.start - 1))));
}

/**
 * Find the load-bearing sites in one source file, without running it.
 *
 * @param {string} source - File text.
 * @param {string} path - Repo-relative path.
 * @returns {{ path: string, line: number, kind: string, text: string }[]} Sites in line order; none for an unjudged path.
 */
export function loadBearingSites(source, path) {
  if (!loadBearingJudged(path)) return [];
  const { code, strings } = lex(source);
  const found = [];
  /** Record one site at an offset. */
  const add = (at, kind) => found.push({ path, line: lineAt(source, at), kind, text: MESSAGES[kind] });
  for (const match of code.matchAll(DETACHED)) add(match.index, 'detached');
  for (const match of code.matchAll(UNREF)) add(match.index, 'unref');
  for (const match of code.matchAll(INTERVAL)) add(match.index, 'daemon-loop');
  for (const match of code.matchAll(FOREVER)) {
    const open = match.index + match[0].length - 1;
    if (/(?<![\w$])await(?![\w$])/u.test(code.slice(open, blockEnd(code, open)))) add(match.index, 'daemon-loop');
  }
  if (namesStateRoot(code, strings)) for (const match of code.matchAll(WRITE)) add(match.index, 'state-file');
  return found.sort((left, right) => left.line - right.line || left.kind.localeCompare(right.kind));
}

/**
 * Count sites per file and kind, so removing one kind cannot pay for another.
 *
 * @param {{ path: string, kind: string }[]} sites
 * @returns {Record<string, Record<string, number>>}
 */
export function loadBearingCounts(sites) {
  const counts = {};
  for (const { path, kind } of sites) {
    counts[path] ??= {};
    counts[path][kind] = (counts[path][kind] ?? 0) + 1;
  }
  return counts;
}

/**
 * Sites past their file's ceiling; a file or kind the ceilings do not list allows none.
 *
 * @param {{ path: string, line: number, kind: string, text: string }[]} sites
 * @param {Record<string, Record<string, number>>} ceilings
 * @returns {{ path: string, line: number, kind: string, text: string }[]}
 */
export function loadBearingGrowth(sites, ceilings) {
  const seen = {};
  return sites.filter(site => {
    const key = `${site.path}:${site.kind}`;
    seen[key] = (seen[key] ?? 0) + 1;
    return seen[key] > (ceilings[site.path]?.[site.kind] ?? 0);
  });
}

/**
 * Ceilings that rose against the accepted ones: a new file or kind, or a larger count. A file moved in the same change
 * (`moves` maps its new path to its old one) starts from its old path's ceiling, so a rename is not a raise; only a
 * count above the old path's is. The old path must be gone from the candidate, or the ceiling was copied, not moved.
 *
 * @param {Record<string, Record<string, number>>} accepted
 * @param {Record<string, Record<string, number>>} candidate
 * @param {Record<string, string>} [moves] - New path to old path, for each file git reports as renamed.
 * @returns {{ path: string, kind: string, from: number, to: number }[]}
 */
export function loadBearingRaised(accepted, candidate, moves = {}) {
  const raised = [];
  for (const [path, kinds] of Object.entries(candidate)) {
    const old = moves[path];
    const origin = old !== undefined && !(old in candidate) && !(path in accepted) ? accepted[old] : undefined;
    for (const [kind, to] of Object.entries(kinds)) {
      const from = accepted[path]?.[kind] ?? origin?.[kind] ?? 0;
      if (to > from) raised.push({ path, kind, from, to });
    }
  }
  return raised;
}

/**
 * The check over changed files: each judged file's sites past the candidate ceilings, and any ceiling the candidate
 * raised over the accepted ceilings, as `path:line: message` rows. The messages say the next step.
 *
 * @param {{ file: string, source: string }[]} changed - Changed files with their candidate text.
 * @param {Record<string, Record<string, number>>} ceilings - The candidate ceilings.
 * @param {Record<string, Record<string, number>> | null} [accepted] - Main's ceilings; null when main has none.
 * @param {Record<string, string>} [moves] - New path to old path for each file moved in this change.
 * @returns {string[]}
 */
export function loadBearingFailures(changed, ceilings, accepted = null, moves = {}) {
  const failures = [];
  for (const { file, source } of changed) {
    for (const site of loadBearingGrowth(loadBearingSites(source, file), ceilings)) {
      failures.push(`${site.path}:${site.line}: load-bearing ${site.kind}: ${site.text} outside the ${LOAD_BEARING_CELLS.join(', ')} cells; make the work a job the drive cell runs, or a result keyed by content in the pin cell`);
    }
  }
  if (accepted) {
    for (const row of loadBearingRaised(accepted, ceilings, moves)) {
      failures.push(`${LOAD_BEARING_CEILINGS}:1: load-bearing ceiling for ${row.path} ${row.kind} rose from ${row.from} to ${row.to}; the ceiling only falls, so move the site into a job instead`);
    }
  }
  return failures;
}
