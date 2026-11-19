/** Bisect sets aside cases base main fails the same way, so a batch red only in main's own reds still lands [C7,#2941]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../../store/index.js';
import { openCellBoard as openBoard } from '../../../../../../store/tests/fixtures/cell.js';
import {
  bisect,
  splitBaseRed,
} from '../../../../../index.js';

const PORTS = { quarantineWaivers: () => [] };
const ITEMS = [{ id: 1, commit: 'c1' }, { id: 2, commit: 'c2' }];
const MAIN_RED = { file: 'apps/cli/journeys/relay/credential.test.js', name: 'a revoked credential is refused' };
const NEW_CASE = { file: 'apps/cli/journeys/relay/credential.test.js', name: 'a brand new case this batch broke' };

/** A landing state on an in-memory board whose saves are recorded. */
function landing(t) {
  const board = openBoard(':memory:', { now: () => new Date('2026-11-04T10:10:00.000Z') });
  t.after(() => store.closeBoard(board));
  const saves = [];
  return { saves, state: { board, landingPorts: PORTS, culprits: [], say() {}, onWait: undefined,
    batch: { id: 'batch', root: '/nowhere', base: 'base', tip: 'tip', revision: 0 },
    write: async (_operation, [{ batch }]) => { saves.push(batch); return batch; } } };
}

/** A base-main comparison where the relay-credential file is red with one named case. */
const mainWith = (rows) => async () => ({ main: 'base', files: rows });
const relayRed = mainWith([{ file: MAIN_RED.file, result: 'red', failures: [{ file: MAIN_RED.file, name: MAIN_RED.name }] }]);

test('landing.bisect.a-case-base-main-fails-by: a case base main fails by the same file and name is known-main; a new case in that file is the batch\'s own [C7,#2941]', async t => {
  const { state } = landing(t);
  assert.deepEqual(await splitBaseRed(state, [MAIN_RED, NEW_CASE], relayRed), { known: [MAIN_RED], own: [NEW_CASE] });
});

test('landing.bisect.a-batch-red-only-in-base: a batch red only in base main\'s own cases returns every item as green and records the known-main cases [C7,#2941]', async t => {
  const { state, saves } = landing(t);
  const green = await bisect(state, ITEMS, [MAIN_RED], 'split', async () => assert.fail('no split gate is needed'), relayRed);
  assert.deepEqual(green, ITEMS);
  assert.deepEqual(saves.at(-1).knownMain, [MAIN_RED]);
});

test('landing.bisect.without-a-base-main-comparison-the: without a base-main comparison the batch is still held [C7,#2941]', async t => {
  const { state, saves } = landing(t);
  const green = await bisect(state, ITEMS, [MAIN_RED], 'split', async () => assert.fail('no split gate'),
    async () => ({ main: 'base', files: [], unavailable: 'main comparison could not be completed' }));
  assert.deepEqual(green, []);
  assert.equal(saves.at(-1).state, 'blocked');
  assert.equal(saves.at(-1).refusal.code, 'LAND_DIAGNOSTIC');
});
