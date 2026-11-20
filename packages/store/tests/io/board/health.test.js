/** @pullboard-test-input source-cell store */
/** applyHealthFindings reads the board's recent health-resolved events so a finding that flaps is shouted once [C7,#1479]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordHealthFindings } from '../../../index.js';
import { HEALTH_EPISODE_ENGINE } from '../../../../state/light.js';
import { fixture } from '../../fixtures/dispatch.js';

const finding = (since, who) => ({ owner: { who }, key: 'flap-fixture', cause: 'UNLANDED_HELD', subject: '#1', title: 'sits', since, why: 'no commit', next: 'ask the builder', item: null });

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

/** One scan of the given findings by the acting seat, and the Stuck and Digest shouts delivered so far. */
function scanner(t) {
  const { board, clock, advance, seats } = fixture(t);
  const scan = findings => recordHealthFindings(board, { agentId: seats.actor.id, findings,
    observedRevision: board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS n FROM event').get().n });
  const shouts = prefix => board.db.prepare("SELECT shout_text AS text FROM shout WHERE shout_from = 'sentinel' AND shout_text LIKE ?").all(`${prefix}%`).map(row => row.text);
  return { board, clock, advance, seats, scan, shouts };
}

const routine = (key, since, who, cause = 'STUCK_BUILD') => ({ owner: { who }, key, cause, subject: `#${key}`, title: 'sits', since, why: 'no commit', next: 'ask the builder', item: null });

test('store.io-board-health.digest-buffer-persists-and-flushes: from HEALTH_EPISODE_ENGINE, applyHealthFindings passes each run through healthDigestPlan and keeps the buffer and each reader last flush in the health-scan event, so three routine findings for one seat over two scans 10 minutes apart get one digest shout naming all three [C7,#1479]', t => {
  const { board, clock, advance, seats, scan, shouts } = scanner(t);
  assert.ok((board.executionEngineVersion ?? HEALTH_EPISODE_ENGINE) >= HEALTH_EPISODE_ENGINE, 'a new board runs the digest engine');
  const since = clock.now().toISOString();
  const findings = ['a', 'b', 'c'].map(key => routine(key, since, seats.builder.id));
  scan(findings);
  assert.equal(shouts('Stuck:').length, 0, 'a routine finding is buffered, not shouted');
  const detail = JSON.parse(board.db.prepare("SELECT event_detail FROM event WHERE event_kind = 'health-scan' ORDER BY event_id DESC LIMIT 1").get().event_detail);
  assert.equal(detail.digest.buffered[seats.builder.id].length, 3, 'the buffer is kept in the health-scan event');
  assert.ok(detail.digest.lastFlush[seats.builder.id], 'the reader window start is kept beside it');
  advance(5 * 60_000);
  scan(findings);
  assert.equal(shouts('Digest:').length, 0, 'inside the window nothing is shouted');
  advance(5 * 60_000);
  scan(findings);
  const digests = shouts('Digest:');
  assert.equal(digests.length, 1, 'a scan with nothing new still flushes a due buffer, once');
  for (const subject of ['#a', '#b', '#c']) assert.match(digests[0], new RegExp(`${subject}\\b`, 'u'));
  advance(60_000);
  scan(findings);
  assert.equal(shouts('Digest:').length, 1, 'the flushed buffer is empty');
});

test('store.io-board-health.digest-immediate-and-old-engine: an UNLANDED_HELD finding is shouted in the same scan, and below HEALTH_EPISODE_ENGINE a scan shouts exactly as before [C7,#1479]', t => {
  const first = scanner(t);
  first.scan([routine('w', first.clock.now().toISOString(), first.seats.builder.id, 'UNLANDED_HELD')]);
  assert.ok(first.shouts('Stuck:').length >= 1, 'an immediate cause is shouted at once');
  const old = scanner(t);
  old.board.executionEngineVersion = HEALTH_EPISODE_ENGINE - 1;
  old.scan([routine('r', old.clock.now().toISOString(), old.seats.builder.id)]);
  assert.equal(old.shouts('Stuck:').length, 1, 'an older engine shouts a routine finding as before');
  assert.equal(old.shouts('Digest:').length, 0);
});
