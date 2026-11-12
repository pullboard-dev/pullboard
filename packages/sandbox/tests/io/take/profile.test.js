/** A build seat's `next --take` on the real-size board selects in under 2 s and picks the board's own next item [N2,C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../../../../store/index.js';
import { fixture } from '../../../../../apps/cli/tests/fixtures/next/take.js';
import { cli } from '../../../../../apps/cli/tests/fixtures/next/take.js';
import { seedRealSize } from '../../../../../apps/cli/tests/fixtures/next/real-size.js';

/** Milliseconds the profile printed for one phase, or null when it printed none. */
function phaseMs(err, phase) {
  const row = err.split('\n').map(line => /^next profile: (.+) (\d+) ms$/u.exec(line)).find(match => match?.[1] === phase);
  return row ? Number(row[2]) : null;
}

test('a build seat selects on the real-size board in under 2 s and takes the board\'s own next item [N2,C7]', { timeout: 600_000 }, async t => {
  const box = await fixture(t);
  seedRealSize(box);
  const seat = box.seats.actor;
  // The board's own read-only pick for this seat, before the take: the item a correct selection must claim.
  const expected = store.nextFor(box.board, { agentId: seat.id, lane: seat.lane }).item?.item_id;
  assert.ok(Number.isSafeInteger(expected), 'the seeded board offers this build seat an item');
  process.env.PULLBOARD_NEXT_PROFILE = '1';
  let run;
  try { run = await cli(box, seat.path, ['next', '--take']); }
  finally { delete process.env.PULLBOARD_NEXT_PROFILE; }
  const selection = phaseMs(run.err, 'selection');
  console.log(`# build seat: selection ${selection} ms; expected #${expected}`);
  await t.test('clause 1: next --take for a build seat spends under 2 s in selection [N2]', () => {
    assert.equal(run.code, 0, run.out + run.err);
    assert.ok(selection !== null && selection < 2_000, `selection took ${selection} ms`);
  });
  await t.test('clause 2: it claims the same item the board selects for this seat [N2]', () => {
    const item = store.getItem(box.board, expected);
    assert.equal(item.item_status, 'claimed', run.out + run.err);
    assert.equal(item.item_owner, seat.id);
  });
});
