/** pullboard stats lists the coordinator's recorded usage on its own entry, and unknown when none is recorded [C7,#9686]. @pullboard-test-input source-cell apps/cli packages/stats packages/store */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** The model name the recorded coordinator session reports. */
const SESSION_MODEL = ['fixture', 'coordinator'].join('-');

test('clause 1: a board with a recorded coordinator session shows its tokens in the stats usage on an entry of its own [C7,#9686]', async t => {
  const box = await fixture(t);
  store.recordCoordinatorUsage(box.board, { session: 'coordinator-session-1', observedAt: 5, records: [{ model: SESSION_MODEL, inputTokens: 10, outputTokens: 4,
    knownInputTokens: 10, knownOutputTokens: 4, wallMs: 0, freshInputTokens: 3, cacheReadInputTokens: 5, cacheWriteInputTokens: 2, unknownReasons: [] }] });
  const stats = await cli(box, box.root, ['stats']);
  assert.equal(stats.code, 0, stats.out + stats.err);
  const { coordinator, models } = stats.document.usage;
  assert.equal(coordinator.sessions, 1);
  assert.equal(coordinator.inputTokens, 10);
  assert.equal(coordinator.outputTokens, 4);
  assert.equal(coordinator.cacheReadInputTokens, 5);
  assert.equal(models.find(row => row.model === SESSION_MODEL)?.inputTokens, 10, 'the usage models total includes the coordinator');
});

test('clause 2: a board with no coordinator rows reports unknown, not zero [C7,#9686]', async t => {
  const box = await fixture(t);
  const stats = await cli(box, box.root, ['stats']);
  assert.equal(stats.code, 0, stats.out + stats.err);
  const { coordinator } = stats.document.usage;
  assert.equal(coordinator.sessions, 0);
  assert.equal(coordinator.inputTokens, null);
  assert.equal(coordinator.outputTokens, null);
  assert.deepEqual(coordinator.unknownReasons, ['not-recorded']);
});
