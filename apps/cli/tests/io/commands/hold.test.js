/** The show and list line of a held item names its holder and reason; hold --list prints one owner's holds [N2,N22,M1,C7]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { itemLine } from '../../../src/io/read.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fileFixtureItem } from '../../../../../packages/gate/tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('cli.io-commands-hold.a-held-item-prints-who-holds-it: a held item prints who holds it and why on its show and list line [N2,N22,M1]', () => {
  for (const lane of ['web', 'api']) {
    const reason = `waiting for the person in ${lane}`;
    const item = { item_id: 1, item_status: 'open', item_lane: lane, item_title: `Held ${lane} item`, item_route: 'mid',
      item_hold_reason: reason, item_hold_by: 'coordinator', item_hold_at: '2026-10-09T12:00:00.000Z' };
    assert.match(itemLine(item, () => 'coordinator (unknown)'), new RegExp(`held by coordinator \\(unknown\\): ${reason}`));
  }
  assert.doesNotMatch(itemLine({ item_id: 2, item_status: 'open', item_lane: 'web', item_title: 'Free', item_route: 'mid', item_hold_reason: null }), /held by/u);
});

test('cli.io-commands-hold.list-person: pullboard hold --list --owner person prints the open person holds as "#<id> <deadline> <reason>", oldest deadline first, and "no person holds" when there are none [C7]', async () => {
  const box = e2e.project();
  const file = async (title) => (await fileFixtureItem(box, box.repo, { lane: 'web', title, criterion: `${title} exists`, check: 'true', wait: true, run: box.runLocal })).item_id;
  const [late, early, lane, free] = [await file('Late hold'), await file('Early hold'), await file('Lane hold'), await file('Free text hold')];
  assert.match((await box.runLocal(box.repo, 'hold', '--list', '--owner', 'person')).out, /^no person holds/u);
  const hold = async (id, reason, ...flags) => { const held = await box.runLocal(box.repo, 'hold', String(id), reason, ...flags); assert.equal(held.code, 0, held.err || held.out); };
  await hold(late, 'needs the decision', '--owner', 'person', '--deadline', '2031-05-06T07:08:09Z');
  await hold(early, 'needs the budget call', '--owner', 'person', '--deadline', '2030-01-02T03:04:05Z');
  await hold(lane, 'waits on web', '--owner', 'lane:web', '--deadline', '2029-01-01T00:00:00Z');
  await hold(free, 'plain free text');
  const listed = await box.runLocal(box.repo, 'hold', '--list', '--owner', 'person');
  assert.equal(listed.code, 0, listed.err || listed.out);
  assert.deepEqual(listed.out.trim().split('\n').filter((line) => line.startsWith('#')), [`#${early} 2030-01-02T03:04:05.000Z needs the budget call`, `#${late} 2031-05-06T07:08:09.000Z needs the decision`]);
  await box.runLocal(box.repo, 'hold', String(early), '--off');
  await box.runLocal(box.repo, 'hold', String(late), '--off');
  assert.match((await box.runLocal(box.repo, 'hold', '--list', '--owner', 'person')).out, /^no person holds/u);
});
