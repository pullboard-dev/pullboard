/** A landing batch judges its red cases against main the way submit does (#2528), so known main reds never jam it [B3,C7]. */
import { completeGate } from './landing-completion.js';
import { compareMainFailures } from './main-red.js';
import { failureSignatures } from './main-failure-matches.js';
import { matchingMainFailures } from './main-failure-matches.js';

/**
 * Split a fully accounted red landing gate into cases red identically on the batch's main base and cases red only in the batch.
 * Why: the same exact-main comparison submit uses decides, case by case, so a case is known-main only when main fails it
 * with the same failure details; cancelled children are not independent failures, but interrupted or unaccounted runs stay red.
 *
 * @param {{ root: string, batch: { root: string, base: string }, onWait?: Function }} state
 * @param {object} gate - The batch's complete gate result.
 * @returns {Promise<{ main: string, known: Array<{file:string,name:string,signature:string}>, remaining: Array<object> }|null>}
 */
export async function knownMainAccount(state, gate) {
  if (gate.isGreen || !completeGate(gate, { allowCancelled: true }) || gate.requiresGreen) return null;
  const failures = failureSignatures(gate, state.batch.root, { allowCancelled: true });
  if (!failures?.length) return null;
  const known = [], remaining = [];
  // Each failing file is compared on its own: a file main cannot run (new in the batch) never hides another file's known case.
  for (const file of [...new Set(failures.map(failure => failure.file))]) {
    const cases = failures.filter(failure => failure.file === file);
    let comparison = null;
    try {
      // The accounted failures name the file even when the reporter's profile carries no per-test rows.
      comparison = await compareMainFailures(state.batch.root, { format: gate.profile?.format, tests: [{ file, passed: false }] }, state.onWait, '',
        { commit: state.batch.base, detailed: true, allowCancelled: true });
    } catch { /* An unavailable comparison never excuses a red case. */ }
    for (const failure of cases) (comparison && matchingMainFailures([failure], comparison, state.batch.base) ? known : remaining).push(failure);
  }
  if (!known.length) return null;
  return { main: state.batch.base, known: known.map(({ file, name, signature }) => ({ file, name, signature })), remaining };
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
