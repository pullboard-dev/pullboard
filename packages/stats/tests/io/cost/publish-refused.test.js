/** @pullboard-test-input packages/stats/src/io/cost/checkpoint.js */
/** One refused usage record never keeps the rest of a seat's usage, and so a busy day's agent time, from publishing [#7578]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeSlice } from '../../../src/io/cost/checkpoint.js';
import { FIXTURE_MODEL } from '../../../../gate/tests/fixtures/testkit.js';
import { Refused } from '../../../../kernel/index.js';

const item = (id, ms = 1000) => ({ item: { agentId: 'seat', item: id, revision: 1, observedAt: 1, records: [{ model: FIXTURE_MODEL, wallMs: ms }] } });
const shared = () => ({ shared: { id: 'g', seats: [], allocations: [], revision: 1, observedAt: 1, records: [] } });

/** A board that refuses the whole batch when it holds the shared group, as the real one does past 100 seats. */
function board() {
  const written = [];
  const ordered = async (_ctx, _board, _operation, [payload]) => {
    if (payload.sharedSessions.length) throw new Refused('USAGE_RECORD', 'a shared group carries at most 100 seats');
    written.push(...payload.items.map(value => value.item));
  };
  return { written, ordered };
}

test('stats.publish-refused.a-refused-shared-group-is-isolated: a refused shared group is isolated and every item revision still publishes [N26]', async () => {
  const { written, ordered } = board();
  const slice = [item(1), item(2), shared(), item(3), item(4)];
  const refused = await writeSlice({}, {}, 'seat', slice, ordered);
  assert.equal(refused, 1);
  assert.deepEqual(written.sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('stats.publish-refused.a-clean-slice-goes-in-one: a clean slice goes in one write and an error that is not a refusal still throws [N26]', async () => {
  let calls = 0;
  assert.equal(await writeSlice({}, {}, 'seat', [item(1), item(2)], async () => { calls++; }), 0);
  assert.equal(calls, 1);
  await assert.rejects(writeSlice({}, {}, 'seat', [item(1)], async () => { throw new Refused('NOT_JOINED', 'join first'); }), { code: 'NOT_JOINED' });
});
