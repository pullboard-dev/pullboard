/** A holder adds test files to its own check; anything not provably a superset stays the coordinator's [C7,V4,H16]. */
import { CHECK_WIDEN_SELF_ENGINE } from './check-widen-self-engine.js';
import { COORDINATOR } from './config.js';
import { ENGINE_VERSION } from './engine-metadata.js';
import { Refused } from './refused.js';

const RUNNER = ['node', 'bin/run-tests.js'];
const SAFE_FILE = /^(?!\/)(?!.*\.\.)[\w./-]+\.m?js$/u;
const REFUSAL = 'CHECK_WIDEN_REFUSED';

/** Split a check on `&&` into segments of words, or null when any shell syntax beyond words is present. */
function segments(command) {
  return command.split('&&').map((part) => part.trim().split(/\s+/u).filter(Boolean));
}

/**
 * The test files a new check adds to the frozen one, or a refusal naming what stops it being a superset.
 * Only `node bin/run-tests.js <flags> <files>` segments may grow; every other segment, the flags and the order must match exactly.
 *
 * @param {string} oldCheck the frozen check
 * @param {string} newCheck the proposed check
 * @returns {string[]} the added files, never empty
 */
export function widenedCheckFiles(oldCheck, newCheck) {
  const refuse = (why) => new Refused(REFUSAL, `only the coordinator changes a check beyond adding test files to node bin/run-tests.js: ${why}; shout the coordinator with the exact --check`);
  if (typeof oldCheck !== 'string' || !oldCheck.trim()) throw refuse('the item has no frozen check to widen');
  const before = segments(oldCheck);
  const after = segments(newCheck);
  if (before.length !== after.length) throw refuse(`the command changed from ${before.length} part(s) to ${after.length}`);
  const added = [];
  before.forEach((old, index) => {
    const next = after[index];
    const runner = RUNNER.every((word, at) => old[at] === word);
    if (!runner) {
      if (old.join(' ') !== next.join(' ')) throw refuse(`the command changed: "${old.join(' ')}" became "${next.join(' ')}"`);
      return;
    }
    if (!RUNNER.every((word, at) => next[at] === word)) throw refuse(`the runner changed: "${old.join(' ')}" became "${next.join(' ')}"`);
    const flags = (words) => words.slice(RUNNER.length).filter((word) => word.startsWith('-'));
    const files = (words) => words.slice(RUNNER.length).filter((word) => !word.startsWith('-'));
    if (flags(old).join(' ') !== flags(next).join(' ')) throw refuse(`the flags changed: "${flags(old).join(' ')}" became "${flags(next).join(' ')}"`);
    for (const file of [...files(old), ...files(next)]) if (!SAFE_FILE.test(file)) throw refuse(`${file} is not a plain test file path`);
    const kept = new Set(files(next));
    for (const file of files(old)) if (!kept.has(file)) throw refuse(`${file} was removed`);
    for (const file of kept) if (!files(old).includes(file) && !added.includes(file)) added.push(file);
  });
  if (!added.length) throw refuse('it adds no test file');
  return added;
}

/** The test files a claim holder adds to its own frozen check, or null when the edit is not that move; a check that is no provable superset is refused by name. */
export function selfWidenedFiles(board, item, agentId, change) {
  if (agentId === COORDINATOR || change.check === undefined || typeof change.check !== 'string') return null;
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < CHECK_WIDEN_SELF_ENGINE) return null;
  if (item.item_status !== 'claimed' || item.item_owner !== agentId) return null;
  if (Object.entries(change).some(([key, value]) => key !== 'check' && value !== undefined)) return null;
  return widenedCheckFiles(item.item_check, change.check.trim());
}
