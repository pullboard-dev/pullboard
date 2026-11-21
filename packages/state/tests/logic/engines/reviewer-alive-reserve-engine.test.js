/** @pullboard-test-input source-cell packages/state */
/** @pullboard-world-pin: the clauses read the committed constants door and the committed engine history snapshots, because the proof is that those files name the engine and keep the older snapshot. */
/** REVIEWER_ALIVE_RESERVE_ENGINE is named by the engine constants through engineNumber at engine 280, with its history snapshot, and the engine 279 snapshot still replays unchanged [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as constants from '../../../src/logic/engine/constants.js';
import * as full from '../../../index.js';

const history = number => JSON.parse(readFileSync(new URL(`../../../data/history/${number}.json`, import.meta.url), 'utf8'));
const source = readFileSync(new URL('../../../src/logic/engine/constants.js', import.meta.url), 'utf8');

test('state.engines-reviewer-alive-reserve.leaf-numbered: clause 1: the constants door names REVIEWER_ALIVE_RESERVE_ENGINE through engineNumber as 280, above CLAIM_CHECK_CEILING_ENGINE, with its history snapshot [C7]', () => {
  assert.match(source, /^export const REVIEWER_ALIVE_RESERVE_ENGINE = engineNumber\('REVIEWER_ALIVE_RESERVE_ENGINE'\);$/mu);
  assert.equal(constants.REVIEWER_ALIVE_RESERVE_ENGINE, 280);
  assert.equal(full.REVIEWER_ALIVE_RESERVE_ENGINE, 280);
  assert.equal(full.REVIEWER_ALIVE_RESERVE_ENGINE, full.CLAIM_CHECK_CEILING_ENGINE + 1);
  const snapshot = history(280);
  assert.deepEqual([snapshot.engine, snapshot.name], [280, 'REVIEWER_ALIVE_RESERVE_ENGINE']);
});

test('state.engines-reviewer-alive-reserve.previous-history-replays: clause 2: every engine the engine 279 snapshot lists keeps its file and number in the 280 snapshot, which adds only the new engine [C7]', () => {
  const before = history(279);
  const after = history(280);
  assert.equal(before.engine, 279);
  for (const row of before.engines) assert.deepEqual(after.engines.find(other => other.name === row.name), row, row.name);
  const added = after.engines.filter(row => !before.engines.some(other => other.name === row.name));
  assert.deepEqual(added.map(row => [row.name, row.number]), [['REVIEWER_ALIVE_RESERVE_ENGINE', 280]]);
});
