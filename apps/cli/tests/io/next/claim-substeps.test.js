/** The opt-in next profile names the ordered claim sub-steps without changing claim writes [C7,N2,#12589]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';

const CLAIM_PHASES = [
  'claim proves-nothing guard',
  'claim missing-paths guard',
  'claim policy and ownership guards',
  'claim budget guard',
  'claim worktree snapshot',
  'claim admission',
  'claim ordered move',
  'claim checkpoint',
];

/** Run one ordinary take with the requested profile setting and restore the process environment. */
async function take(t, profile) {
  const box = await fixture(t);
  box.add('Profile claim sub-steps');
  const previous = process.env.PULLBOARD_NEXT_PROFILE;
  if (profile) process.env.PULLBOARD_NEXT_PROFILE = '1';
  else delete process.env.PULLBOARD_NEXT_PROFILE;
  try {
    return { box, taken: await cli(box, box.seats.actor.path, ['next', '--take']) };
  } finally {
    if (previous === undefined) delete process.env.PULLBOARD_NEXT_PROFILE;
    else process.env.PULLBOARD_NEXT_PROFILE = previous;
  }
}

test('cli.io-next-claim-substeps.profiled-claimOrdered: clause 1: PULLBOARD_NEXT_PROFILE reports each ordered claim sub-step with milliseconds [C7,N2,#12589]', async t => {
  const { taken } = await take(t, true);
  assert.equal(taken.code, 0, taken.out + taken.err);
  const rows = taken.err.split('\n').filter(line => line.startsWith('next profile: '));
  for (const phase of CLAIM_PHASES) {
    assert.ok(rows.some(line => line.startsWith(`next profile: ${phase} `) && /\d+ ms$/u.test(line)),
      `profile has a timed row for ${phase}: ${rows.join(' | ')}`);
  }
});

test('cli.io-next-claim-substeps.default-claim-output-and-event: clause 2: without PULLBOARD_NEXT_PROFILE next --take omits profile output and records the normal claim event [C7,N2,#12589]', async t => {
  const { box, taken } = await take(t, false);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.ok(!taken.err.includes('next profile:'), taken.err);
  const item = box.board.db.prepare("SELECT item_id FROM item WHERE item_title = 'Profile claim sub-steps'").get();
  const event = box.board.db.prepare("SELECT event_kind, event_detail FROM event WHERE item_id = ? AND event_kind = 'claim' ORDER BY event_id DESC LIMIT 1").get(item.item_id);
  assert.equal(event.event_kind, 'claim');
  assert.equal(JSON.parse(event.event_detail).agentId, box.seats.actor.id);
});
