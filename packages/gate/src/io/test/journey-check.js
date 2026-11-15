/** Check each delete-tagged journey against the mutation scores of the cells that cover it, and retag it convert when the score drops [C7]. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TEST_MANIFEST_FILE } from './manifest.js';
import { formatTestManifest } from './manifest.js';
import { generateTestManifest } from './manifest.js';
import { generateTestTiers } from './tiers.js';
import { coveringCells } from '../../logic/test/journey-check.js';
import { holdShare } from '../../logic/test/journey-check.js';
import { judgeJourney } from '../../logic/test/journey-check.js';
import { retagChecked } from '../../logic/test/journey-check.js';

const USAGE = 'usage: journey-check [--limit n] [--cells n] [--faults n] [--manifest file] [--write] [project-root]\n';
const NUMBERS = { '--limit': 'limit', '--cells': 'cells', '--faults': 'faults' };

/** Parse the flags into options, or null when anything is unknown or a number is missing. */
function parse(args) {
  const options = { limit: Infinity, cells: 3, faults: 6, manifest: TEST_MANIFEST_FILE, write: false, root: '.' };
  const rest = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (arg === '--write') options.write = true;
    else if (arg === '--manifest') options.manifest = args[++at];
    else if (NUMBERS[arg]) {
      const value = Number(args[++at]);
      if (!Number.isInteger(value) || value < 1) return null;
      options[NUMBERS[arg]] = value;
    } else if (arg.startsWith('-')) return null;
    else rest.push(arg);
  }
  if (rest.length > 1 || !options.manifest) return null;
  if (rest.length) options.root = rest[0];
  return options;
}

/** At most `count` items, evenly spread over the list so a sample is not one folder's worth. */
function spread(list, count) {
  if (list.length <= count) return list;
  return Array.from({ length: count }, (_, at) => list[Math.floor((at * list.length) / count)]);
}

/** Import hops from a test that count as reached: the test, the module it imports, and what that module imports (a barrel's re-exports). */
const REACH_DEPTH = 2;

/**
 * Every test file's nearby files, by walking imports a few hops as the manifest does.
 * Why only a few hops: through shared barrels the full closure of every test is most of the repository (about 1,450 files), so a filter on it selected every test for every fault.
 * A fault in a file a test only reaches deeper than that is left to the cell's other tests; the journey is still judged on the same faults.
 *
 * @param {string} root project root
 * @param {number} [depth] import hops counted
 * @returns {Map<string, Set<string>>} reached files by test file, root-relative
 */
export function testReach(root, depth = REACH_DEPTH) {
  const found = new Map();
  generateTestTiers(root, { depth, onReach: row => { found.set(row.file, row.reached); } });
  return found;
}

/** The reach of the tests one mutation run can use: the cell's own tests and the journey, as plain lists. */
function reachFor(reached, cell, journey) {
  const out = {};
  for (const [file, set] of reached) if (file === journey || file.startsWith(`${cell}/`)) out[file] = [...set];
  return out;
}

/** The manifest rows: the written file when it exists, else generated from source. */
function manifestRows(root, manifest) {
  const path = resolve(root, manifest);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).files : generateTestManifest(root).files;
}

/**
 * The check command: for a sample of delete-tagged journeys, run the mutation check on each covering cell with the journey
 * beside the cell's own tests, say per journey what the score is with and without it, and report the share of tags that hold.
 * Why a sample flag: a mutation run executes the cell's tests once per fault, so a full pass is slow.
 *
 * @param {string[]} args see USAGE
 * @param {{ mutate: Function, reachOf?: Function, say?: (line: string) => void }} seams the mutation runner `(root, cell, { all, extra, sample, extraLast, reach }) => report`, passed in because a package never imports an app; reachOf reads every test's reached files and defaults to walking the imports; say gets each line the moment it is known, so a run that is cut short has still printed its verdicts
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
export async function runJourneyCheck(args, { mutate, reachOf = testReach, say = () => {} }) {
  const options = parse(args);
  if (!options) return { status: 1, stdout: '', stderr: USAGE };
  const root = resolve(options.root);
  const rows = manifestRows(root, options.manifest);
  const deletes = rows.filter(row => row.tag === 'delete').sort((a, b) => (a.file < b.file ? -1 : 1));
  const sampled = spread(deletes, options.limit);
  const reached = reachOf(root);
  const verdicts = [];
  const lines = [];
  const add = line => { lines.push(line); say(line); };
  for (const [at, journey] of sampled.entries()) {
    say(`checking ${at + 1} of ${sampled.length}: ${journey.file}`);
    const reports = [];
    for (const { cell } of coveringCells(rows, journey, options.cells)) {
      reports.push({ cell, report: await mutate(root, cell, { all: true, extra: [journey.file], sample: options.faults, extraLast: true, note: say, reach: reachFor(reached, cell, journey.file) }) });
    }
    const verdict = judgeJourney(journey.file, reports);
    verdicts.push(verdict);
    add(`${verdict.verdict}  ${journey.file}  ${verdict.because}`);
    for (const cell of verdict.cells) add(`  ${cell.cell}  with ${cell.with}/${cell.seeded}  without ${cell.without}/${cell.seeded}`);
  }
  const { sampled: total, held, converted, unmeasured, share } = holdShare(verdicts);
  add(`${held} of ${total} sampled delete tags hold (${Math.round(share * 100)}%); ${converted} retagged convert, ${unmeasured} unmeasured, of ${deletes.length} delete tags`);
  if (options.write && converted) writeFileSync(resolve(root, options.manifest), formatTestManifest({ files: retagChecked(rows, verdicts) }));
  return { status: 0, stdout: lines.join('\n') + '\n', stderr: '' };
}
