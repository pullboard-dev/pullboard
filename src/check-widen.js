/** A holder adds test files to its own check; anything not provably a superset stays the coordinator's [C7,V4,H16]. */
import { CHECK_WIDEN_SELF_ENGINE } from './check-widen-self-engine.js';
import { COORDINATOR } from './config.js';
import { coordinatorCheck } from './item-check-baseline.js';
import { ENGINE_VERSION } from './engine-metadata.js';
import { Refused } from './refused.js';

const RUNNER = ['node', 'bin/run-tests.js'];
const SAFE_FILE = /^(?!\/)(?!.*\.\.)[\w./-]+\.m?js$/u;
const REFUSAL = 'CHECK_WIDEN_REFUSED';

/** Split a check on `&&` into segments of words, or null when any shell syntax beyond words is present. */
function segments(command) {
  return command.split('&&').map((part) => part.trim().split(/\s+/u).filter(Boolean));
}

/** Flags that take no value; every other flag binds the next word as its value, so an option is never mistaken for a file. */
const BOOLEAN_FLAGS = new Set(['--test-force-exit']);

/** Split runner words into option strings (a flag with its bound value, in order) and the selected files. */
function parseRunnerWords(words) {
  const options = [];
  const files = [];
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at];
    if (!word.startsWith('-')) files.push(word);
    else if (BOOLEAN_FLAGS.has(word) || word.includes('=')) options.push(word);
    else options.push(at + 1 < words.length ? `${word} ${words[++at]}` : word);
  }
  return { options, files };
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
    const parsed = (words) => parseRunnerWords(words.slice(RUNNER.length));
    const [was, now] = [parsed(old), parsed(next)];
    if (was.options.join(' ') !== now.options.join(' ')) throw refuse(`the options changed: "${was.options.join(' ')}" became "${now.options.join(' ')}"`);
    const files = (found) => found.files;
    for (const file of [...files(was), ...files(now)]) if (!SAFE_FILE.test(file)) throw refuse(`${file} is not a plain test file path`);
    const kept = new Set(files(now));
    for (const file of files(was)) if (!kept.has(file)) throw refuse(`${file} was removed`);
    for (const file of kept) if (!files(was).includes(file) && !added.includes(file)) added.push(file);
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

/** The edit's check command: the coordinator's, or a holder's proven widening; anyone else is refused. */
export function editCheck(agentId, check, widened) {
  return widened ? check.trim() : coordinatorCheck(agentId, check);
}
