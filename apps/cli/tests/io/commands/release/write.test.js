/** With health.lapsedSweep on, claim, submit and verify issue only their own board write; the sentinel expires lapsed claims [C7,#8924]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { maintainLapsedBeforeWrite } from '../../../../src/io/claim.js';
import { crossLaneFixture } from '../../../fixtures/e2e.js';
import { fixtureSettledMachine } from '../../../fixtures/testkit.js';

/** Read the fixture board directly: its event count and one item's owner. */
function look(box, fn) {
  const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return fn(db); } finally { db.close(); }
}
const events = box => look(box, db => db.prepare('SELECT COUNT(*) AS n FROM event').get().n);
const owner = (box, id) => look(box, db => db.prepare('SELECT item_owner FROM item WHERE item_id=?').get(id).item_owner);

test('cli.journeys-release-one-write.a-claim-issues-exactly-one-board: clause 1: a claim issues exactly one board write, with no inline lapsed-claim expiry, when health.lapsedSweep is on [C7,#8924]', async t => {
  const box = crossLaneFixture(t);
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { health: { lapsedSweep: true } });
  const first = box.seat('one-write-first', 'web', box.session);
  const second = box.seat('one-write-second', 'web', 'one-write-second-session');
  const lapsing = box.add('web', 'Claim that will lapse');
  const next = box.add('web', 'Claim made beside a lapsed one');
  const before = events(box);
  box.json(await box.runAsLocal(box.session, first.root, 'claim', String(lapsing), '--json'));
  const plain = events(box) - before;
  assert.ok(plain >= 1, 'a claim records at least its own write');
  look(box, db => db.prepare('UPDATE item SET item_lease_until=? WHERE item_id=?').run('2000-01-01T00:00:00.000Z', lapsing));
  const mark = events(box);
  box.json(await box.runAsLocal('one-write-second-session', second.root, 'claim', String(next), '--json'));
  assert.equal(events(box) - mark, plain, 'a claim beside a lapsed lease writes no more than a claim beside none');
  assert.equal(owner(box, lapsing), first.agent, 'the lapsed claim is left for the sentinel');
});

test('cli.journeys-release-one-write.claim-submit-and-verify-run-no: clause 2: claim, submit and verify run no inline lapsed-claim capture when health.lapsedSweep is on, and still do when it is off [C7,#8924]', async () => {
  const captured = [];
  const ports = lapsedOn => ({ lapsedOn: () => lapsedOn, recovered: () => false, capture: () => { captured.push(lapsedOn); return null; } });
  const ctx = { io: {}, info: { root: '.' } };
  for (const operation of ['claim', 'submit', 'verify']) {
    await maintainLapsedBeforeWrite(ctx, {}, operation, [], 'seat-1', ports(true));
  }
  assert.deepEqual(captured, [], 'with the sweep on, no operation captures lapsed claims');
  for (const operation of ['claim', 'submit', 'verify']) {
    await maintainLapsedBeforeWrite(ctx, {}, operation, [], 'seat-1', ports(false));
  }
  assert.deepEqual(captured, [false, false, false], 'with the sweep off, each operation still does');
});
