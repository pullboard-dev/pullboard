/** next on a 20-item board selects once for each item it claims, plus one stop, with a median under 2 s [C7,N2,#5768,#7461]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { nextSelection } from '../../../../packages/moves/index.js';
import { fixture } from '../../tests/fixtures/next/take.js';
import { cli } from '../../tests/fixtures/next/take.js';

test('clause 1 and clause 2: with 20 eligible items each next selects once per claim and the median next is under 2 s [C7,N2]', async t => {
  const box = await fixture(t);
  for (let n = 1; n <= 20; n++) box.add(`Twenty item ${n}`, { brief: `Files: web/twenty-${n}.js\nTest: the real board hands out one of twenty items.` });
  const pick = nextSelection.pick;
  let picks = 0;
  nextSelection.pick = (...args) => { picks++; return pick(...args); };
  t.after(() => { nextSelection.pick = pick; });
  const times = [];
  for (let run = 0; run < 5; run++) {
    const before = picks;
    const started = performance.now();
    const result = await cli(box, box.seats.actor.path, ['next']);
    times.push(performance.now() - started);
    assert.equal(result.code, 0, result.out + result.err);
    const id = result.document?.item?.item_id;
    assert.ok(Number.isSafeInteger(id), result.out + result.err);
    // The default loop tops the seat up to N claims (#7461): one selection per claim it made, and at most one more that found no room.
    const claimed = [id, ...(result.document.more ?? []).map(entry => entry.item.item_id)];
    assert.ok(picks - before >= claimed.length && picks - before <= claimed.length + 1,
      `next #${run + 1} selected ${picks - before} times for ${claimed.length} claim(s)`);
    for (const each of claimed) store.release(box.board, each, box.seats.actor.id, 'Measured next hands the item back', 'OTHER');
  }
  const median = [...times].sort((a, b) => a - b)[2];
  t.diagnostic(`next ms: ${times.map(ms => Math.round(ms)).join(', ')}; median ${Math.round(median)}`);
  assert.ok(median < 2_000, `median next took ${Math.round(median)} ms`); // budget: the #5768 bar, median next under 2 s on 20 items.
});
