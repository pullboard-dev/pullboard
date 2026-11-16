/** A holder adds test files to its own check; anything not provably a superset stays the coordinator's [C7,V4,H16]. */
import { CHECK_WIDEN_SELF_ENGINE } from '../../../../state/light.js';
import { COORDINATOR } from '../../../../config/index.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { Refused } from '../../../../kernel/index.js';

const RUNNER = 'node apps/cli/src/io/run/tests.js';
/** Checks frozen before the launcher moved still name the old path, which forwards to the same launcher. */
const FROZEN_RUNNER = 'node packages/gate/src/io/run/tests.js';
const isRunner = (part) => [RUNNER, FROZEN_RUNNER].some((runner) => part === runner || part.startsWith(`${runner} `));
const APPENDED = /^(?: [A-Za-z0-9_./-]+\.test\.js)+$/u;
const PLAIN_PART = /^[A-Za-z0-9_ ./=-]+$/u;
const REFUSAL = 'CHECK_WIDEN_REFUSED';

/**
 * The test files a new check adds to the frozen one, or a refusal naming the first position where they differ.
 * The new check must be the frozen one byte for byte, with plain `.test.js` paths appended, single-space separated,
 * at the end of one or more `node apps/cli/src/io/run/tests.js` parts of a ` && ` chain; no parsing of options or quoting is attempted.
 *
 * @param {string} oldCheck the frozen check
 * @param {string} newCheck the proposed check
 * @returns {string[]} the added files, never empty
 */
export function widenedCheckFiles(oldCheck, newCheck) {
  const refuse = (why) => new Refused(REFUSAL, `only the coordinator changes a check beyond appending test files to a node apps/cli/src/io/run/tests.js part: ${why}; shout the coordinator with the exact --check`);
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
      if (!isRunner(was) || !PLAIN_PART.test(was)) throw refuse(`${where}, in a part that is not a plain ${RUNNER} part`);
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

const LANE_TEST_PART = /^(?:node --test|node (?:bin\/run-tests|(?:packages\/gate|apps\/cli)\/src\/io\/run\/tests)\.js)(?: --test-force-exit)?((?: [A-Za-z0-9_][A-Za-z0-9_./-]*\.test\.js)+)$/u;

/**
 * The test files of a check that is only `node --test` or `node apps/cli/src/io/run/tests.js` over plain .test.js paths, joined by &&;
 * null for any other check. Why: a lane seat may file such a check over files its lane owns [C7,#2908]; the CLI proves ownership.
 */
export function laneCheckFiles(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const files = [];
  for (const part of command.trim().split(' && ')) {
    const match = LANE_TEST_PART.exec(part);
    if (!match) return null;
    files.push(...match[1].trim().split(' '));
  }
  return files.some(file => file.split('/').includes('..')) ? null : files;
}

/** Refuse a seat's check when any named test file belongs to another lane; `laneOf(config, file)` is the caller's ownership port. */
export function requireOwnLaneCheck(config, me, lane, check, laneOf) {
  if (check === undefined || me.id === COORDINATOR) return;
  const files = laneCheckFiles(check);
  if (!files) return;
  for (const file of files) {
    const owner = laneOf(config, file);
    if (owner !== lane || (me.lane && me.lane !== lane)) {
      throw new Refused('LANE_CHECK_FOREIGN', `${file} belongs to ${owner === COORDINATOR ? 'the coordinator' : `lane ${owner}`}, not lane ${lane}; a lane seat's check names test files its own lane owns`,
        `shout ${owner === COORDINATOR ? 'coordinator' : owner} to set a check that names ${file}`);
    }
  }
}

/** Normalize an explicitly supplied check when its author is the coordinator, or a seat naming only test files [V2,C7]. */
export function coordinatorCheck(agentId, command) {
  if (command === undefined) return undefined;
  if (agentId !== COORDINATOR && typeof command === 'string' && laneCheckFiles(command)) return command.trim();
  if (agentId !== COORDINATOR) {
    throw new Refused('COORDINATOR_CHECK', 'only the coordinator sets or edits an item check; ask your coordinator to supply --check');
  }
  if (typeof command !== 'string') throw new Refused('BAD_CHECK', 'an item check is a command string; ask your coordinator to supply --check "<command>"');
  return command.trim();
}

