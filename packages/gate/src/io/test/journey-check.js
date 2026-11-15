/** Check each delete-tagged journey against the mutation scores of the cells that cover it, and retag it convert when the score drops [C7]. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TEST_MANIFEST_FILE } from './manifest.js';
import { formatTestManifest } from './manifest.js';
import { generateTestManifest } from './manifest.js';
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
 * @param {{ mutate: Function }} seams the mutation runner `(root, cell, { all, extra, sample }) => report`, passed in because a package never imports an app
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
export async function runJourneyCheck(args, { mutate }) {
  const options = parse(args);
  if (!options) return { status: 1, stdout: '', stderr: USAGE };
  const root = resolve(options.root);
  const rows = manifestRows(root, options.manifest);
  const deletes = rows.filter(row => row.tag === 'delete').sort((a, b) => (a.file < b.file ? -1 : 1));
  const sampled = spread(deletes, options.limit);
  const verdicts = [];
  const lines = [];
  for (const journey of sampled) {
    const reports = [];
    for (const { cell } of coveringCells(rows, journey, options.cells)) {
      reports.push({ cell, report: await mutate(root, cell, { all: true, extra: [journey.file], sample: options.faults }) });
    }
    const verdict = judgeJourney(journey.file, reports);
    verdicts.push(verdict);
    lines.push(`${verdict.verdict}  ${journey.file}  ${verdict.because}`);
    for (const cell of verdict.cells) lines.push(`  ${cell.cell}  with ${cell.with}/${cell.seeded}  without ${cell.without}/${cell.seeded}`);
  }
  const { sampled: total, held, converted, unmeasured, share } = holdShare(verdicts);
  lines.push(`${held} of ${total} sampled delete tags hold (${Math.round(share * 100)}%); ${converted} retagged convert, ${unmeasured} unmeasured, of ${deletes.length} delete tags`);
  if (options.write && converted) writeFileSync(resolve(root, options.manifest), formatTestManifest({ files: retagChecked(rows, verdicts) }));
  return { status: 0, stdout: lines.join('\n') + '\n', stderr: '' };
}
