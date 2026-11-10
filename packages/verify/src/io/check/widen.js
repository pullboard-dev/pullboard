/** A holder adds test files to its own check; anything not provably a superset stays the coordinator's [C7,V4,H16]. */
import { CHECK_WIDEN_SELF_ENGINE } from '../../../../state/light.js';
import { COORDINATOR } from '../../../../config/index.js';
import { coordinatorCheck } from '../../../light.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { Refused } from '../../../../kernel/index.js';

const RUNNER = 'node packages/gate/src/io/run/tests.js';
const APPENDED = /^(?: [A-Za-z0-9_./-]+\.test\.js)+$/u;
const PLAIN_PART = /^[A-Za-z0-9_ ./=-]+$/u;
const REFUSAL = 'CHECK_WIDEN_REFUSED';

/**
 * The test files a new check adds to the frozen one, or a refusal naming the first position where they differ.
 * The new check must be the frozen one byte for byte, with plain `.test.js` paths appended, single-space separated,
 * at the end of one or more `node packages/gate/src/io/run/tests.js` parts of a ` && ` chain; no parsing of options or quoting is attempted.
 *
 * @param {string} oldCheck the frozen check
 * @param {string} newCheck the proposed check
 * @returns {string[]} the added files, never empty
 */
export function widenedCheckFiles(oldCheck, newCheck) {
  const refuse = (why) => new Refused(REFUSAL, `only the coordinator changes a check beyond appending test files to a node packages/gate/src/io/run/tests.js part: ${why}; shout the coordinator with the exact --check`);
  if (typeof oldCheck !== 'string' || !oldCheck.trim()) throw refuse('the item has no frozen check to widen');
  const before = oldCheck.split(' && ');
  const after = newCheck.split(' && ');
  let offset = 0;
  const added = [];
  const present = new Set(oldCheck.split(' '));
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    const [was, now] = [before[index], after[index]];
    if (was === undefined || now === undefined) throw refuse(`the chain of commands differs at part ${index + 1}`);
    if (was !== now) {
      const tail = now.startsWith(was) ? now.slice(was.length) : null;
      let at = 0;
      while (at < was.length && at < now.length && was[at] === now[at]) at += 1;
      const where = `the check differs at character ${offset + at + 1}`;
      if (tail === null || !APPENDED.test(tail)) throw refuse(where);
      if (!(was === RUNNER || was.startsWith(`${RUNNER} `)) || !PLAIN_PART.test(was)) throw refuse(`${where}, in a part that is not a plain ${RUNNER} part`);
      if (/^-/u.test(was.split(' ').at(-1)) && was.split(' ').at(-1) !== '--test-force-exit') throw refuse(`${where}, after an option that may take the next word as its value`);
      for (const file of tail.slice(1).split(' ')) {
        if (present.has(file) || added.includes(file)) throw refuse(`${file} is already in the check`);
        added.push(file);
      }
    }
    offset += was.length + 4;
  }
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
