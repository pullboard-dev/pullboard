/** @pullboard-test-input source-cell packages/state */
/** @pullboard-world-pin: clause 2 reads the committed engine history snapshots under packages/state/data/history, which are the subject of the rule. */
/** CLAIM_CHECK_CEILING_ENGINE is exported by the state door as one number above MERGED_AT_ENGINE, and the claim move declares CHECK_OVER_CEILING [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import * as full from '../../../index.js';
import { MOVES } from '../../../src/logic/machine/move/claim.js';

/** The engine history keeps the previous snapshot as it landed [C7]. */
const history = (n) => JSON.parse(readFileSync(new URL(`../../../data/history/${n}.json`, import.meta.url), 'utf8'));

test('state.engines-claim-check-ceiling.leaf-numbered: clause 1: CLAIM_CHECK_CEILING_ENGINE is a number above MERGED_AT_ENGINE and the claim move lists CHECK_OVER_CEILING [C7]', () => {
  assert.equal(typeof full.CLAIM_CHECK_CEILING_ENGINE, 'number');
  assert.ok(full.CLAIM_CHECK_CEILING_ENGINE > full.MERGED_AT_ENGINE, `${full.CLAIM_CHECK_CEILING_ENGINE} is above MERGED_AT_ENGINE`);
  const codes = MOVES.find(move => move.verb === 'claim').alsoRefuses.map(row => row.code);
  assert.ok(codes.includes('CHECK_OVER_CEILING'), 'claim alsoRefuses names CHECK_OVER_CEILING');
});

test('state.engines-claim-check-ceiling.previous-replays-unchanged: clause 2: the engine 278 history snapshot stays as landed and only engine 279 names the claim ceiling engine [C7]', () => {
  const before = history(278), after = history(279);
  assert.equal(before.engine, 278);
  assert.ok(!before.engines.some(engine => engine.name === 'CLAIM_CHECK_CEILING_ENGINE'), 'engine 278 does not know the new engine');
  assert.equal(before.engines.find(engine => engine.name === 'MERGED_AT_ENGINE').number, 278);
  assert.equal(after.engine, 279);
  assert.equal(after.engines.find(engine => engine.name === 'CLAIM_CHECK_CEILING_ENGINE').number, 279);
  assert.equal(full.MERGED_AT_ENGINE, 278);
});
