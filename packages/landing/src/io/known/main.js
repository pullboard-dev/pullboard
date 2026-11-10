/** A landing batch judges its red cases against main the way submit does (#2528), so known main reds never jam it [B3,C7]. */
import { isAbsolute } from 'node:path';
import { completeGate } from '../completion.js';
import { carriedMainOutcome } from '../main/red.js';
import { compareMainFailures } from '../main/red.js';
import { sameTestInputs } from '../main/red.js';
import { failureSignatures } from '../main/matches.js';
import { matchingMainFailures } from '../main/matches.js';
import { laneOf } from '../../../../seats/index.js';
import { listItems } from '../../../../store/index.js';
import { gitSpawnSync } from '../../../../git/index.js';

/**
 * Split a fully accounted red landing gate into cases red identically on the batch's main base and cases red only in the batch.
 * Why: the same exact-main comparison submit uses decides, case by case, so a case is known-main only when main fails it
 * with the same failure details; cancelled children are not independent failures, but interrupted or unaccounted runs stay red.
 *
 * @param {{ root: string, batch: { root: string, base: string }, onWait?: Function, compareMainFailures?: Function }} state - `compareMainFailures` is the port that compares one failing file with main; tests inject it to observe the calls [C7].
 * @param {object} gate - The batch's complete gate result.
 * @returns {Promise<{ main: string, known: Array<{file:string,name:string,signature:string}>, remaining: Array<object>, unavailable: string[] }|null>}
 *   unavailable lists the files whose base-main comparison could not run
 */
export async function knownMainAccount(state, gate) {
  if (gate.isGreen || !completeGate(gate, { allowCancelled: true }) || gate.requiresGreen) return null;
  // A by-case match needs only each failure's file and name, so a run whose details cannot all be signed (a timed-out
  // file) still compares every named case instead of skipping the whole account [C7,#3073].
  const failures = failureSignatures(gate, state.batch.root, { allowCancelled: true }) ?? gate.accounted ?? null;
  if (!failures?.length) return null;
  const known = [], remaining = [];
  let changed = null;
  const unavailable = [];
  // Each failing file is compared on its own: a file main cannot run (new in the batch) never hides another file's known case.
  // The files compare at once, bounded by the gate slots the comparisons take; one after another, six red files cost
  // six comparisons' wall time while the runners sat idle [C7].
  const files = [...new Set(failures.map(failure => failure.file))];
  changed = changedFiles(state);
  const comparisons = await Promise.all(files.map(async file => {
    try {
      // A file the batch did not touch keeps main's newest measured outcome: no rerun on this main, the refresh behind
      // the landing re-measures it [C7]. A touched file is compared on this exact main.
      const carried = changed && !changed.has(file) ? carriedMainOutcome(state.batch.root, file) : null;
      // The accounted failures name the file even when the reporter's profile carries no per-test rows.
      // A content-keyed main red excuses this file only when the batch left its inputs as main has them [C7,#3166].
      const unchanged = carried ? true : await sameTestInputs(state.batch.root, state.batch.base, 'HEAD', file);
      const comparison = carried ?? await (state.compareMainFailures ?? compareMainFailures)(state.batch.root, { format: gate.profile?.format, tests: [{ file, passed: false }] }, state.onWait, '',
        // A landing's comparison waits as a landing, ahead of seat submits in the slot line; as a plain diagnostic it
        // queued 5.6 minutes behind four builders' analysis runs on 6 Nov [C7].
        { commit: state.batch.base, detailed: true, allowCancelled: true, contentCache: unchanged, runnerAdmission: { landing: true } });
      if (comparison?.unavailable) { unavailable.push(`${file}: ${comparison.unavailable}`); state.say?.(`main comparison unavailable for ${file}: ${comparison.unavailable}`); }
      else {
        // Keep the answer for the base split: it ran the same file on main a second time on 6 Nov, 3 minutes each [C7].
        (state.mainComparisons ??= new Map()).set(file, comparison);
        const row = comparison?.files?.find(entry => entry.file === file);
        state.say?.(`main comparison for ${file} ${carried ? 'carried from' : 'at'} ${comparison?.main?.slice(0, 12) ?? 'unknown'}: ${row ? `${row.result}, ${(row.failures ?? []).length} failing case(s)` : 'no row for this file'}`);
      }
      return comparison;
    } catch (error) { unavailable.push(`${file}: ${error?.code ?? 'ERROR'}`); state.say?.(`main comparison unavailable for ${file}: ${error?.code ?? 'ERROR'} ${String(error?.message ?? '').slice(0, 160)}`); return null; /* An unavailable comparison never excuses a red case. */ }
  }));
  for (const [index, file] of files.entries()) {
    const comparison = comparisons[index];
    for (const failure of failures.filter(entry => entry.file === file)) (comparison && (matchingMainFailures([failure], comparison, comparison.main, { byCase: true })
      || redOnMainUntouched(failure, comparison, changed ??= changedFiles(state))) ? known : remaining).push(failure);
  }
  if (!known.length && !unavailable.length) return null;
  return { main: state.batch.base, known: known.map(({ file, name, signature }) => ({ file, name, signature })), remaining, unavailable };
}

/**
 * The gate fields a known-main account changes: its failures keep only the batch's own red cases, and a gate red only in
 * known-main cases carries a proof naming them. Why: every landing path (batch, trunk, parallel, bisection) then judges
 * the batch by what it broke, through the same proof check it uses for waivers.
 */
export function knownMainFields(gate, account) {
  return { knownMain: account.known, failures: account.remaining, accounted: account.remaining,
    knownMainProof: account.remaining.length ? null : { tree: gate.tree, failures: [], knownMain: account.known, logPath: gate.logPath } };
}

/** One line naming each known-main case, for the landing's own output. */
export function knownMainLine(account) {
  return `known main red at ${account.main.slice(0, 12)} (not failing this batch): ${account.known.map(row => `${row.file} :: ${row.name}`).join('; ')}`;
}

/** Quote one literal file for a stored check command. */
function word(file) { return "'" + file.replaceAll("'", "'\\''") + "'"; }

/**
 * File one Main red item per file for cases red at the batch's base main as well, or reuse the one already pending, so
 * main's own red is owned by a repair and never charged to the batch's items [C7,#3073]. A file no lane owns is said
 * aloud for the coordinator; filing never stops the landing.
 *
 * @param {{ board: object, config: object, batch: { id: string, base: string, root: string }, write: Function, say: Function }} state
 * @param {Array<{file: string, name: string}>} known - The known-main cases.
 * @returns {Promise<Array<{file: string, item: number}>>} The Main red item for each file.
 */
export async function fileKnownMainReds(state, known) {
  const filed = [];
  for (const file of [...new Set(known.map(row => row.file))]) {
    // The whole filing is contained: a board read or write error is said aloud and the landing goes on.
    try {
      const title = `Main red: ${file}`;
      const pending = listItems(state.board, { all: true }).find(item => item.item_title === title && !item.item_merged_commit
        && ['open', 'claimed', 'submitted', 'verified'].includes(item.item_status));
      if (pending) { filed.push({ file, item: pending.item_id }); continue; }
      const lane = laneOf({ lanes: state.config.lanes }, file);
      if (!lane || lane === 'coordinator') { state.say(`main red ${file} has no owning lane; the coordinator must file its repair`); continue; }
      const cases = known.filter(row => row.file === file).map(row => row.name);
      const criterion = `Repair these exact cases on main ${state.batch.base}: ${cases.join('; ')}. They fail at main alone, found by landing batch ${state.batch.id}.`;
      // A repair is diagnosed by the seat that takes it, so it files on the strong route.
      const item = await state.write('addItem', [{ by: 'coordinator', lane, title, route: 'strong', specIds: [], parentId: null, after: [],
        criterion, brief: `Files: ${file}\nTest: Run the stored exact-file check; every case named in the criterion must pass.\nSource: landing batch ${state.batch.id}; main ${state.batch.base}`,
        check: `${String(state.config.affectedTests ?? '').trim()} ${word(file)}`.trim() }]);
      filed.push({ file, item: typeof item === 'object' ? item?.item_id ?? item?.item?.item_id : item });
    } catch (error) { state.say(`main red ${file} was not filed (${error.message}); the coordinator must file its repair`); }
  }
  return filed;
}

/**
 * Whether a whole-file failure that names no case sits in a test file main itself fails while no batch item changed it.
 * Why: an item lands unless its own change breaks a test that passes on main [C7,#3073]. Named cases are matched one by
 * one; only a runner abort that names no case has nothing to match, and it kept main's red files blocking every batch.
 *
 * @param {{file: string, ran?: string}} failure - One batch failure.
 * @param {{ files: Array<{file: string, result: string}>, coarseFiles?: Array<{file: string, result: string}> }} comparison - Main's run of the failing files.
 * @param {Set<string>|null} changed - Files the batch changed against its base; null when they cannot be read.
 * @returns {boolean}
 */
export function redOnMainUntouched(failure, comparison, changed) {
  if (!changed || !failure?.file || !unnamedFileFailure(failure)) return false;
  const file = failure.ran ?? failure.file;
  const rows = [...(comparison.files ?? []), ...(comparison.coarseFiles ?? [])];
  return rows.some(row => row.file === file && row.result === 'red') && !changed.has(file) && !changed.has(failure.file);
}

/** The files the batch's merged tree changed against its base, or null when Git cannot say. */
export function changedFiles(state) {
  const diff = gitSpawnSync(['diff', '--name-only', '-z', `${state.batch.base}...HEAD`], { cwd: state.batch.root, encoding: 'utf8' });
  return diff.status === 0 ? new Set(diff.stdout.split('\0').filter(Boolean)) : null;
}

/** Whether a failure is a whole-file row naming no case: the reporter names it by the file's own path. */
function unnamedFileFailure(failure) {
  const name = String(failure.name ?? '');
  // Only the bare path itself: a case title that merely mentions the path never qualifies.
  return name === failure.file || (isAbsolute(name) && !/\s/u.test(name) && name.endsWith(`/${failure.file}`));
}
