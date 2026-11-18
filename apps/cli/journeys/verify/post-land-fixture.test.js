/** The landed-review fixture records a forced landing built by a seat of a named family, with no verdict [C7,#9862]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listAgents } from '../../../../packages/store/index.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import {
  fixture,
  landedBy,
} from '../../tests/fixtures/land/failure.js';

const FAMILY = 'Fixture Build Vendor';

test('cli.journeys-verify-post-land-fixture.the-helper-records-a-forced-landing: clause 1: the helper records a forced landing whose builder seat has the chosen family and returns its item id [C7,#9862]', async t => {
  const box = await fixture(t);
  const id = await landedBy(box, t, { family: FAMILY });
  assert.equal(Number.isInteger(id), true, 'the helper returns the landing item id');
  const row = box.itemOf(id);
  assert.ok(row.item_built_by, 'a seat submitted it');
  assert.ok(row.item_merged_commit, 'it is recorded as landed');
  const seat = onBoard(box, board => listAgents(board)).find(agent => agent.agent_id === row.item_built_by);
  assert.equal(seat?.agent_family, FAMILY, 'the builder seat declared the chosen family');
});

test('cli.journeys-verify-post-land-fixture.the-recorded-landing-has-that-family: clause 2: the recorded landing has that family as its builder and no verdict [C7,#9862]', async t => {
  const box = await fixture(t);
  const id = await landedBy(box, t, { family: FAMILY });
  const row = box.itemOf(id);
  assert.equal(row.item_builder_family, FAMILY, 'the item records the builder family');
  assert.equal(row.item_verdict ?? null, null, 'no verdict was given');
});
