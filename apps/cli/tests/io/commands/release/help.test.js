/** pullboard help release says what each build reason does to the release-twice hold, and the help matches the rule [C7,#10957]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { cli } from '../../../fixtures/next/take.js';
import { fixture } from '../../../fixtures/next/take.js';

const COUNTED = ['INELIGIBLE', 'BLOCKED', 'BUDGET', 'ROUTED_ELSEWHERE'];
const UNCOUNTED = ['OTHER', 'TAKEN_OVER'];

/** The help line for one reason: it starts with the reason's code. */
function reasonLine(text, reason) {
  return text.split('\n').map(line => line.trim()).find(line => line.startsWith(`${reason} `)) ?? '';
}

test('cli.journeys-release-help-reasons.reason-effects: clause 1: help release prints one line per build reason, and says INELIGIBLE, BLOCKED, BUDGET and ROUTED_ELSEWHERE count toward the release-twice hold while OTHER and TAKEN_OVER do not [C7,#10957]', async t => {
  const box = await fixture(t);
  const help = await cli(box, box.seats.actor.path, ['help', 'release']);
  assert.equal(help.code, 0, help.out + help.err);
  const text = help.document.help;
  for (const reason of COUNTED) assert.match(reasonLine(text, reason), /: counts toward the release-twice hold/u, `${reason} is listed as counted`);
  for (const reason of UNCOUNTED) assert.match(reasonLine(text, reason), /does not count toward the release-twice hold/u, `${reason} is listed as not counted`);
  assert.match(text, /INELIGIBLE, BLOCKED, BUDGET and ROUTED_ELSEWHERE count toward the release-twice hold; OTHER and TAKEN_OVER do not/u);
});

/** Two seats in turn claim the item and release it with the reason; true when the item is then held. */
async function heldAfterTwo(t, reason) {
  const box = await fixture(t);
  const id = box.add(`Released twice with ${reason}`);
  for (const seat of [box.seats.actor, box.seats.builder]) {
    const claimed = await cli(box, seat.path, ['claim', String(id), '--no-next']);
    assert.equal(claimed.code, 0, claimed.out + claimed.err);
    const released = await cli(box, seat.path, ['release', String(id), '--reason', reason, '--note', 'Release twice check']);
    assert.equal(released.code, 0, released.out + released.err);
    box.advance(31 * 60_000);
  }
  return Boolean(store.getItem(box.board, id).item_hold_reason);
}

test('cli.journeys-release-help-reasons.reason-effects-live: clause 2: on a fixture board, two releases of one item with a reason the help lists as counted leave it held, and two with OTHER do not [C7,#10957]', async t => {
  assert.equal(await heldAfterTwo(t, 'INELIGIBLE'), true, 'two INELIGIBLE releases hold the item');
  assert.equal(await heldAfterTwo(t, 'OTHER'), false, 'two OTHER releases leave it open');
});
