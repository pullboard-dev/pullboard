/**
 * Lander v2's judge of a red composition: every failing case is charged to main, quarantined after one green rerun,
 * or left red for its item to carry back. Why: a red never holds the trunk; each one has an owner [C7,#5862].
 */

/** How long a quarantine record stands before its file blocks again: 48 h, the window its repair item has [C7,#5862]. */
export const QUARANTINE_MS = 48 * 60 * 60 * 1000;

/** The identity of one failing case: its file and test name. */
function caseKey(failure) {
  return JSON.stringify([failure.file, failure.name]);
}

/**
 * Sort failing cases into `main` (base main fails that exact case), `flaky` (the file passed its one rerun) and `red`
 * (failed twice, or its file is already quarantined in the window, so a second flake is the item's).
 * @param {{file: string, name: string}[]} failures the composition's failing cases
 * @param {{file: string, name: string}[]} known cases base main fails the same way
 * @param {string[]} rerunGreen files green on their single rerun
 * @param {string[]} quarantined files with an unexpired quarantine record
 */
export function judgeReds(failures, known, rerunGreen, quarantined = []) {
  const charged = new Set(known.map(caseKey));
  const green = new Set(rerunGreen);
  const held = new Set(quarantined);
  const main = [], flaky = [], red = [];
  for (const failure of failures) {
    if (charged.has(caseKey(failure))) main.push(failure);
    else if (green.has(failure.file) && !held.has(failure.file)) flaky.push(failure);
    else red.push(failure);
  }
  return { main, flaky, red };
}

/**
 * One quarantine record per flaky file: its cases, input key, expiry and repair item.
 * @param {{file: string, name: string}[]} flaky cases whose file passed its rerun
 * @param {{ now: Date, inputKey: (file: string) => string|null, repair: (file: string) => number|null }} ports
 */
export function quarantineRecords(flaky, { now, inputKey, repair }) {
  const files = [...new Set(flaky.map(failure => failure.file))];
  const expiresAt = new Date(now.getTime() + QUARANTINE_MS).toISOString();
  return files.map(file => ({ file, names: flaky.filter(failure => failure.file === file).map(failure => failure.name),
    inputKey: inputKey(file), expiresAt, repair: repair(file) }));
}

/** The files of every quarantine record still standing at `now`, across the given batches. */
export function openQuarantines(batches, now) {
  const at = now.toISOString();
  return [...new Set(batches.flatMap(batch => batch.quarantine ?? []).filter(record => record.expiresAt > at).map(record => record.file))];
}
