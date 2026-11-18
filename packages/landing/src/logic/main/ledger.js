/** The reds a land job may count as main's own from the board's ledger rows, behind landing.ledgerMainReds [C7,U152]. */
// Budget: the newest this many red files ride on a land job, so its request stays small on a board with many reds.
const MAIN_REDS_CAP = 400;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/**
 * The files the ledger's red-now list (packages/gate redNow over the board's test_result rows) records red, each with
 * the commit its newest red row ran at, newest first, as `[file, commit]` pairs for a land job's `mainReds`; empty when
 * landing.ledgerMainReds is off or no red names a commit. The caller passes redNow's answer, so this module reads no board.
 * Why: a land job's contracts held an item for a red main already had unless a rerun on the base matched it case for
 * case (#8477 held #8249 three times); the ledger already records which files are red, so the runner reads that instead.
 * The runner keeps only the pairs whose commit is on main at or before the base it merged onto.
 *
 * @param {{ landing?: { ledgerMainReds?: boolean } } | null | undefined} config
 * @param {Array<{file: string, inputKey: string, context: string, commit: string|null, at: number}>} reds - redNow's red files.
 * @returns {Array<[string, string]>}
 */
export function landingMainReds(config, reds) {
  if (config?.landing?.ledgerMainReds !== true || !Array.isArray(reds)) return [];
  const newest = new Map();
  for (const red of reds) {
    if (!SHA.test(String(red.commit ?? ''))) continue;
    const seen = newest.get(red.file);
    if (!seen || red.at > seen.at) newest.set(red.file, red);
  }
  return [...newest.values()].sort((a, b) => b.at - a.at || a.file.localeCompare(b.file)).slice(0, MAIN_REDS_CAP).map(red => [red.file, red.commit]);
}
