/** A land job that could not merge an accepted item under separate publish gives it back for a main merge, keeping its accept; a red or hook-refused one still holds [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellSandbox } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { boardJobQueueCall } from '../../index.js';
import { claimJob } from '../../index.js';
import { jobRequest } from '../../index.js';
import { offerJob } from '../../index.js';
import { offerProofShards } from '../../src/io/gate.js';
import { shardJobs } from '../../index.js';

const STAMP = '2026-11-16T12:00:00.000Z';
const MAIN = 'a'.repeat(40);
const TRUNK = 'b'.repeat(40);

/** A board with item 7 accepted at MAIN (its accept recorded), built by core-1, and one claimed separate-publish land job offered for it. */
function landing(t) {
  const board = cellBoard(t, ':memory:');
  board.db.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'landed', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
    VALUES (7, 'core-2', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, ?)`).run(MAIN, 'd'.repeat(64), MAIN, STAMP);
  board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)').run(STAMP, 'core-2', 'accept', 7, JSON.stringify({ commit: MAIN }));
  board.db.prepare('INSERT OR IGNORE INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run('coordinator', 'core', '/seat/coordinator', 'strong', STAMP);
  board.db.exec('INSERT INTO temp.moving VALUES (1)');
  board.db.prepare(`UPDATE item SET item_status='verified', item_commit=?, item_owner='core-1', item_lease_until='2099-01-01T00:00:00.000Z', item_frozen_digest=?, item_built_by='core-1', item_verified_by='core-2', item_verdict='ACCEPT' WHERE item_id=7`)
    .run(MAIN, 'd'.repeat(64));
  board.db.exec('DELETE FROM temp.moving');
  offerJob(board.db, { id: 'land:1:k', kind: 'land', base: MAIN, needs: [], payload: { items: [{ id: 7 }], publish: 'separate' }, now: 1 });
  const held = claimJob(board.db, { runner: 'r-land', capabilities: [], now: 2 });
  const post = receipt => boardJobQueueCall(board, { action: 'receipt', job: 'land:1:k', runner: 'r-land', token: held.token, receipt }, { mode: 'pull', now: 3 });
  return { board, post };
}

const row = board => board.db.prepare('SELECT item_status, item_hold_at FROM item WHERE item_id = 7').get();
const notes = board => board.db.prepare("SELECT event_kind, event_detail FROM event WHERE item_id = 7 AND event_kind <> 'accept'").all().map(event => `${event.event_kind} ${event.event_detail}`).join(' | ').slice(0, 800);
const events = (board, kind) => board.db.prepare('SELECT event_detail FROM event WHERE item_id = 7 AND event_kind = ?').all(kind).map(event => JSON.parse(event.event_detail));

test('api.gate.land-conflict-reopens-for-merge: clause 1: a separate-publish land job that could not merge an accepted item reopens it for a main merge naming the conflicting files, keeps its accept recorded, leaves no hold, and shouts its builder [C7]', t => {
  const { board, post } = landing(t);
  post({ kind: 'land', outcome: 'returned', base: TRUNK, trunk: null, landed: [], already: [],
    returned: [{ id: 7, reason: 'conflict', detail: 'CONFLICT (content): Merge conflict in packages/a.js\nCONFLICT (content): Merge conflict in packages/b.js\nAutomatic merge failed' }] });
  const after = row(board);
  assert.equal(after.item_hold_at, null, 'no hold');
  const why = notes(board);
  assert.notEqual(after.item_status, 'verified', `the item went back to its builder: ${why}`);
  assert.equal(events(board, 'accept').length, 1, 'its accept stays recorded');
  const [reopen] = events(board, 'reopen');
  assert.deepEqual(reopen.conflict?.files ?? reopen.files, ['packages/a.js', 'packages/b.js'], 'the reopen names the conflicting files');
  const shouts = board.db.prepare('SELECT shout_to, shout_text FROM shout').all();
  assert.ok(shouts.some(shout => shout.shout_to === 'core-1' && /#7 is back with you/u.test(shout.shout_text)), 'its builder is shouted');
});

test('api.gate.land-red-under-separate-still-holds: clause 2: a red or hook-refused land job under separate publish still holds the accepted item [C7]', t => {
  for (const reason of ['red', 'hook']) {
    const { board, post } = landing(t);
    post({ kind: 'land', outcome: 'returned', base: TRUNK, trunk: null, landed: [], already: [], returned: [{ id: 7, reason, detail: 'test failed: a.test.js' }] });
    const after = row(board);
    assert.equal(after.item_status, 'verified', `${reason} keeps the item accepted`);
    assert.ok(after.item_hold_at, `${reason} parks it on a hold: ${notes(board)}`);
    assert.equal(events(board, 'reopen').length, 0);
  }
});

/** A gate job whose receipt's proof plan splits three files two to a core, offered as shards and read back as the runner reads them: each shard's data.shard by index. */
function shardData(t, needs) {
  const dir = cellSandbox(t).dir;
  const board = cellBoard(t, join(dir, 'board.sqlite'), undefined, { real: true });
  board.seat = cellSeat(board, { lane: 'web', path: join(dir, 'seat') });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  offerJob(board.db, { id: 'gate:s', kind: 'gate', item: item.item_id, candidate: MAIN, base: MAIN, now: 1,
    request: { run: ['true'], input: { entry: 'gate.js', data: {} } } });
  const proofPlan = { runner: 'node --test', cores: 2, files: ['web/a.test.js', 'web/b.test.js', 'web/c.test.js'], ...(needs ? { needs } : {}) };
  const receipt = { version: 1, status: 0, gate: { source: MAIN, green: true, phases: [], proofPlan } };
  const answer = offerProofShards(board, { job: 'gate:s', receipt, offered: { item: item.item_id, candidate: MAIN, main: MAIN, submit: { agentId: board.seat.id } } });
  assert.equal(answer.shards.length, 2);
  // The offered gate job is claimable too, so claim until every job is read and keep the requests that carry a shard.
  const shards = [];
  for (let claims = 0; claims < 3; claims++) {
    const held = claimJob(board.db, { runner: 'r-shard', capabilities: [], now: 8 });
    const shard = jobRequest(board.db, { job: held.job, runner: 'r-shard', token: held.token }).request.input.data.shard;
    if (shard) shards.push(shard);
  }
  return shards.sort((a, b) => a.index - b.index);
}

test('api.gate.shard-carries-browser-gui-need: clause 1: offerProofShards puts plan { browser, gui } in each shard\'s data.shard, true when any of that shard\'s files is in the proof plan\'s needs.browser or needs.gui [C7]', t => {
  const [first, second] = shardData(t, { browser: ['web/b.test.js'], gui: ['web/c.test.js'] });
  assert.deepEqual(first.files, ['web/a.test.js', 'web/c.test.js']);
  assert.deepEqual(first.plan, { browser: false, gui: true });
  assert.deepEqual(second.files, ['web/b.test.js']);
  assert.deepEqual(second.plan, { browser: true, gui: false });
});

test('api.gate.shard-plan-absent-without-needs: clause 2: a proof plan with no needs field adds no plan to the shard [C7]', t => {
  for (const shard of shardData(t, null)) assert.equal('plan' in shard, false, 'a shard of a plan with no needs carries no plan');
});

test('api.io-gate.shard-jobs-key-range: clause 1: shardJobs returns exactly a gate\'s own shard rows in order, not a sibling gate whose job id extends the same text, and its query plan searches job_id with no scan of job [C7]', t => {
  const board = cellBoard(t, ':memory:');
  for (const [id, kind, created] of [['gate:1:a:shard:2', 'gate-shard', 2], ['gate:1:a:shard:1', 'gate-shard', 1], ['gate:1:ab:shard:1', 'gate-shard', 1], ['gate:1:a', 'gate', 0], ['gate:1:a:shard:3', 'gate', 3]]) {
    board.db.prepare('INSERT INTO job (job_id, job_kind, job_step, job_created, job_updated) VALUES (?, ?, ?, ?, ?)').run(id, kind, 'offered', created, created);
  }
  assert.deepEqual(shardJobs(board.db, 'gate:1:a').map(shard => shard.job_id), ['gate:1:a:shard:1', 'gate:1:a:shard:2']);
  assert.deepEqual(shardJobs(board.db, 'gate:1:ab').map(shard => shard.job_id), ['gate:1:ab:shard:1']);
  const plan = board.db.prepare("EXPLAIN QUERY PLAN SELECT job_id, job_step FROM job WHERE +job_kind = ? AND job_id >= ? AND job_id < ? ORDER BY job_created, job_id").all('gate-shard', 'gate:1:a:shard:', 'gate:1:a:shard;').map(step => step.detail).join(' | ');
  assert.match(plan, /SEARCH job/u, plan);
  assert.doesNotMatch(plan, /SCAN job/u, plan);
});
