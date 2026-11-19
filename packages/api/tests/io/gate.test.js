/** A land job that could not merge an accepted item under separate publish gives it back for a main merge, keeping its accept; a red or hook-refused one still holds [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';
import { closeCellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { openCellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import * as jobs from '../../../jobs/index.js';
import { headTree } from '../../../git/index.js';
import { openBoardForRead } from '../../../store/index.js';
import * as store from '../../../store/index.js';
import { poolHandlers } from '../../index.js';
import { provideMainComparison } from '../../index.js';
import { applyMainTestReceipt } from '../../src/io/recheck.js';
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

const SEEDED_FILE = 'web/a.test.js';
const SEEDED_CASE = 'loads under load';
const SIGNATURE = 'c'.repeat(64);
const COMMAND = 'node --test';

/** Seed through a real claim, post main's receipt for the seeded row, then run a pulled gate red only in that case with `signature`; returns the gate's outcome, its notes and the main-test rows before and after. */
async function seededGate(t, signature) {
  const project = cellProject(t, { real: true, config: { affectedTests: COMMAND } });
  const home = join(project.dir, 'machine-home');
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, { gate: { fencedHop: false, runnerDispatch: 'pull', settleOnMainReceipt: true } });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { provideMainComparison(null); if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const head = project.git(project.repo, 'rev-parse', 'HEAD');
  const tree = project.git(project.repo, 'rev-parse', 'HEAD^{tree}');
  const rowId = `main-test:${tree}:${SEEDED_FILE}:${COMMAND}`;
  // The lookup a serving board provides: main's keyed receipt when it recorded one, else the main-test row a gate would queue.
  provideMainComparison(({ db, cases }) => ({ classes: [...new Set(cases.map(row => row.file))].map(file => {
    const answered = jobs.jobsOf(db, { kind: 'main-test' }).some(job => job.id === rowId && job.steps.some(step => step.name === 'receipt' && step.seq === 0));
    return { file, owner: answered ? 'main' : 'unknown', own: [], receipt: answered ? rowId : null, job: answered ? null : rowId };
  }) }));
  const board = openCellBoard(project.boardFile, undefined, { gitRoot: project.repo });
  let lease, item, seat;
  try {
    for (let other = 1; other <= 12; other++) {
      const job = `gate:${other}:x:shard:0`;
      jobs.createJob(board.db, { id: job, kind: 'gate-shard', item: 500 + other, now: Date.now() });
      jobs.writeStep(board.db, job, 'receipt', { runner: 'r', attempt: 1, receipt: { status: 1, gate: { phases: [{ role: 'proof', status: 1, failures: [{ file: SEEDED_FILE, name: SEEDED_CASE }] }] } } }, { seq: 1, now: Date.now() });
    }
    seat = cellSeat(board, { lane: 'web', path: `${project.repo}/seat` });
    item = cellItem(board, { lane: 'web', title: 'Build the page' });
    cellClaim(board, item.item_id, seat, { root: project.repo });
    const held = store.getItem(board, item.item_id);
    offerJob(board.db, { id: 'gate:seeded', kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
      request: { run: ['true'], input: { entry: 'gate.js', data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree: headTree(project.repo), files: [] } } });
    lease = claimJob(board.db, { runner: 'r-gate', capabilities: [], now: 2 });
  } finally { closeCellBoard(board); }
  const handlers = poolHandlers({ boardOpeners: { openBoard: openCellBoard, openBoardForRead, moveArgs: body => [body.verb] } });
  const call = (body, now) => handlers.jobs({ board: { id: 'fixture', root: project.repo }, body, now });
  const rows = () => { const b = openCellBoard(project.boardFile, undefined, { gitRoot: project.repo }); try { return jobs.jobsOf(b.db, { kind: 'main-test' }).map(job => job.id); } finally { closeCellBoard(b); } };
  // A runner's claim seeds the row; the row is offered, and the receipt a runner would post for it is applied.
  const claiming = openCellBoard(project.boardFile, undefined, { gitRoot: project.repo });
  try { boardJobQueueCall(claiming, { action: 'claim', runner: 'r-seed', capabilities: ['node22'] }, { mode: 'pull', now: 5 }); } finally { closeCellBoard(claiming); }
  assert.deepEqual(rows(), [rowId], 'the claim queued the seeded main-test row');
  const b = openCellBoard(project.boardFile, undefined, { gitRoot: project.repo });
  try {
    const tail = 'PULLBOARD_MAIN_TEST ' + JSON.stringify({ green: false, status: 1, failing: [SEEDED_CASE], signatures: [SIGNATURE], inputKey: null });
    assert.equal(applyMainTestReceipt({ db: b.db, gitRoot: project.repo }, { job: rowId, receipt: { tail, commit: head } }, { now: 6 }).verdict, 'red');
  } finally { closeCellBoard(b); }
  const before = rows();
  const gate = { version: 1, source: head, green: false, phases: [{ role: 'proof', status: 1, failures: [{ file: SEEDED_FILE, name: SEEDED_CASE }], failureSignatures: [signature], tail: 'not ok' }], analysis: { proofFiles: [SEEDED_FILE], proofCommand: COMMAND } };
  const answer = await call({ action: 'receipt', job: 'gate:seeded', runner: 'r-gate', token: lease.token, receipt: { status: 1, gate } }, 20);
  const reopened = openCellBoard(project.boardFile, undefined, { gitRoot: project.repo });
  try {
    const notes = reopened.db.prepare('SELECT event_kind, event_detail FROM event WHERE item_id = ?').all(item.item_id).map(event => `${event.event_kind} ${event.event_detail}`).join(' | ');
    return { outcome: answer.applied?.outcome, notes, before, after: jobs.jobsOf(reopened.db, { kind: 'main-test' }).map(job => job.id) };
  } finally { closeCellBoard(reopened); }
}

test('api.io-gate.seeded-receipt-settles-main-owned: clause 2: with the seeded receipt posted, a real pulled gate whose only reds are cases red on main under the same name and signature settles review with those cases listed main-owned, no unknown step and no new main-test row, and a case whose signature differs stays red [C7,P7,#12035]', async t => {
  const same = await seededGate(t, SIGNATURE);
  assert.equal(same.outcome, 'review', same.notes);
  assert.match(same.notes, /also fails on main/u, 'the case is listed as main-owned');
  assert.doesNotMatch(same.notes, /main receipt missing/u, 'no unknown step');
  assert.deepEqual(same.after, same.before, 'no new main-test row');
  const differs = await seededGate(t, 'd'.repeat(64));
  assert.notEqual(differs.outcome, 'review', 'a case whose signature differs stays red');
});

test('api.io-gate.shard-jobs-key-range: clause 1: shardJobs returns exactly a gate\'s own shard rows in order, not a sibling gate whose job id extends the same text, and its query plan searches job_id with no scan of job [C7]', t => {
  const board = cellBoard(t, ':memory:');
  for (const [id, kind, created] of [['gate:1:a:shard:2', 'gate-shard', 2], ['gate:1:a:shard:1', 'gate-shard', 1], ['gate:1:ab:shard:1', 'gate-shard', 1], ['gate:1:a', 'gate', 0], ['gate:1:a:shard:3', 'gate', 3]]) {
    board.db.prepare('INSERT INTO job (job_id, job_kind, job_step, job_created) VALUES (?, ?, ?, ?)').run(id, kind, 'offered', created);
  }
  assert.deepEqual(shardJobs(board.db, 'gate:1:a').map(shard => shard.job_id), ['gate:1:a:shard:1', 'gate:1:a:shard:2']);
  assert.deepEqual(shardJobs(board.db, 'gate:1:ab').map(shard => shard.job_id), ['gate:1:ab:shard:1']);
  const plan = board.db.prepare("EXPLAIN QUERY PLAN SELECT job_id, job_step FROM job WHERE +job_kind = ? AND job_id >= ? AND job_id < ? ORDER BY job_created, job_id").all('gate-shard', 'gate:1:a:shard:', 'gate:1:a:shard;').map(step => step.detail).join(' | ');
  assert.match(plan, /SEARCH job/u, plan);
  assert.doesNotMatch(plan, /SCAN job/u, plan);
});
