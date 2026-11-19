/** @pullboard-test-input source-cell store */
/** applyHealthFindings reads the board's recent health-resolved events so a finding that flaps is shouted once [C7,#1479]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordHealthFindings } from '../../../index.js';
import { fixture } from '../../fixtures/dispatch.js';

const finding = (since, who) => ({ owner: { who }, key: 'flap-fixture', cause: 'STUCK_BUILD', subject: '#1', title: 'sits', since, why: 'no commit', next: 'ask the builder', item: null });

test('store.io-board-health.flap-reads-recent-resolved-events: applyHealthFindings builds recentlyResolved from health-resolved events of the last 30 minutes by board clock, so a finding that resolves and returns 10 minutes later gets one Stuck shout, not two [C7,#1479]', t => {
  const { board, clock, advance, seats } = fixture(t);
  const owner = seats.builder.id;
  const scan = findings => recordHealthFindings(board, { agentId: seats.actor.id, findings,
    observedRevision: board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS n FROM event').get().n });
  const stuck = () => board.db.prepare("SELECT COUNT(*) AS n FROM shout WHERE shout_from = 'sentinel' AND shout_text LIKE 'Stuck:%'").get().n;
  scan([finding(clock.now().toISOString(), owner)]);
  assert.equal(stuck(), 1, 'the first episode shouts once');
  advance(60_000);
  scan([]);
  advance(10 * 60_000);
  scan([finding(clock.now().toISOString(), owner)]);
  assert.equal(stuck(), 1, 'the same finding back after 10 minutes is the same episode and is not shouted again');
  advance(60_000);
  scan([]);
  advance(40 * 60_000);
  scan([finding(clock.now().toISOString(), owner)]);
  assert.equal(stuck(), 2, 'a finding back after more than 30 minutes shouts as a new episode');
});
