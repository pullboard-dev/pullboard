/** A land job that could not merge an accepted item under separate publish gives it back for a main merge, keeping its accept; a red or hook-refused one still holds [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { realGitAdapter } from '../../../git/index.js';
import { withGitContractAdapter } from '../../../git/index.js';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { cellSandbox } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { headTree } from '../../../git/index.js';
import * as store from '../../../store/index.js';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { boardJobQueueCall } from '../../index.js';
import { claimJob } from '../../index.js';
import { jobRequest } from '../../index.js';
import { offerJob } from '../../index.js';
import { applyGateReceipt } from '../../src/io/gate.js';
import { offerProofShards } from '../../src/io/gate.js';
import { WIDE_SEED_SQL } from '../../src/io/recheck.js';
import { settleDoneShardGates } from '../../src/io/gate.js';
import { settleWaitingGates } from '../../src/io/gate.js';
import { ledgerMissReasons } from '../../../store/index.js';
import { recordTestResults } from '../../../store/index.js';

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
function shardData(t, needs, seed) {
  const dir = cellSandbox(t).dir;
  const board = cellBoard(t, join(dir, 'board.sqlite'), undefined, { real: true });
  board.seat = cellSeat(board, { lane: 'web', path: join(dir, 'seat') });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  if (seed) seed(board.db);
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

/** Every job a runner can claim from the board, read as the runner reads it: id, the shard's files, and whether its data asks for the runner alone. */
function claimedShards(board) {
  const seen = [];
  for (let held = claimJob(board.db, { runner: 'r-timing', capabilities: [], now: 8 }); held; held = claimJob(board.db, { runner: 'r-timing', capabilities: [], now: 8 })) {
    const data = jobRequest(board.db, { job: held.job, runner: 'r-timing', token: held.token }).request.input.data;
    if (data.shard) seen.push({ job: held.job, files: data.shard.files, of: data.shard.of, alone: data.checkTiming === true, keyed: 'checkTiming' in data });
  }
  return seen.sort((a, b) => a.job.localeCompare(b.job));
}

/** A gate job whose passed receipt carries `plan` as its proof plan, offered as shards; the answer and the shards a runner reads. */
function gateShards(t, plan) {
  const dir = cellSandbox(t).dir;
  const board = cellBoard(t, join(dir, 'board.sqlite'), undefined, { real: true });
  board.seat = cellSeat(board, { lane: 'web', path: join(dir, 'seat') });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  offerJob(board.db, { id: 'gate:t', kind: 'gate', item: item.item_id, candidate: MAIN, base: MAIN, now: 1, request: { run: ['true'], input: { entry: 'gate.js', data: {} } } });
  const receipt = { version: 1, status: 0, gate: { source: MAIN, green: true, phases: [], proofPlan: { runner: 'node --test', ...plan } } };
  const answer = offerProofShards(board, { job: 'gate:t', receipt, offered: { item: item.item_id, candidate: MAIN, main: MAIN, submit: { agentId: board.seat.id } } });
  return { answer, shards: claimedShards(board) };
}

/** A claimed land job whose runner asks the board, through the jobs route, to shard `plan`; the answer and the shards a runner reads. */
function landShards(t, plan) {
  const dir = cellSandbox(t).dir;
  const board = cellBoard(t, join(dir, 'board.sqlite'), undefined, { real: true });
  offerJob(board.db, { id: 'land:1:t', kind: 'land', base: MAIN, needs: [], now: 4 });
  const held = claimJob(board.db, { runner: 'r-land', capabilities: [], now: 5 });
  const answer = boardJobQueueCall(board, { action: 'shards', job: 'land:1:t', runner: 'r-land', token: held.token, merged: TRUNK,
    plan: { runner: 'node --test', ...plan }, gate: { run: ['node', '-e', 'x'], entry: 'gate.js', commits: [MAIN] } }, { mode: 'pull', now: 6 });
  return { answer, shards: claimedShards(board) };
}

const TIMED = ['web/a.test.js', 'web/b.test.js', 'web/c.test.js', 'web/d.test.js', 'web/e.test.js'];

test('api.gate.timing-files-own-exclusive-shards: clause 1: offerProofShards gives each proofPlan.timing file its own gate-shard whose data carries checkTiming: true, splits the rest round-robin with no checkTiming, and shards a plan with a timing file even within its cores [C7]', t => {
  const { answer, shards } = gateShards(t, { cores: 2, files: TIMED, timing: ['web/d.test.js', 'web/elsewhere.test.js'] });
  assert.deepEqual(answer.shards, ['gate:t:shard:1', 'gate:t:shard:2', 'gate:t:shard:3']);
  assert.deepEqual(shards.map(({ job, files, of, alone }) => ({ job, files, of, alone })), [
    { job: 'gate:t:shard:1', files: ['web/a.test.js', 'web/c.test.js'], of: 3, alone: false },
    { job: 'gate:t:shard:2', files: ['web/b.test.js', 'web/e.test.js'], of: 3, alone: false },
    { job: 'gate:t:shard:3', files: ['web/d.test.js'], of: 3, alone: true },
  ], 'the timing file is a shard of its own; a timing name outside the plan\'s files is ignored');
  assert.equal(shards.some(shard => !shard.alone && shard.keyed), false, 'an ordinary shard carries no checkTiming key');
  const within = gateShards(t, { cores: 4, files: ['web/a.test.js', 'web/b.test.js'], timing: ['web/b.test.js'] });
  assert.deepEqual(within.shards.map(({ files, alone }) => ({ files, alone })), [{ files: ['web/a.test.js'], alone: false }, { files: ['web/b.test.js'], alone: true }],
    'a plan within its cores still shards when a file is timing');
});

test('api.gate.land-timing-files-own-exclusive-shards: clause 2: offerLandShards, through the jobs route action shards, gives each land plan timing file its own shard whose data carries checkTiming: true [C7]', t => {
  const { answer, shards } = landShards(t, { cores: 2, files: TIMED, timing: ['web/a.test.js'] });
  assert.equal(answer.sharded, true);
  assert.deepEqual(shards.map(({ job, files, alone }) => ({ job, files, alone })), [
    { job: 'land:1:t:shard:1', files: ['web/b.test.js', 'web/d.test.js'], alone: false },
    { job: 'land:1:t:shard:2', files: ['web/c.test.js', 'web/e.test.js'], alone: false },
    { job: 'land:1:t:shard:3', files: ['web/a.test.js'], alone: true },
  ]);
  const within = landShards(t, { cores: 8, files: ['web/a.test.js', 'web/b.test.js'], timing: ['web/a.test.js'] });
  assert.equal(within.answer.sharded, true, 'a land plan within its cores still shards when a file is timing');
  assert.deepEqual(within.shards.map(({ files, alone }) => ({ files, alone })), [{ files: ['web/b.test.js'], alone: false }, { files: ['web/a.test.js'], alone: true }]);
});

test('api.gate.no-timing-plan-unchanged: clause 3: a plan with no timing field offers the same round-robin shards as before, none carrying checkTiming, and a plan within its cores is not split [C7]', t => {
  const gate = gateShards(t, { cores: 2, files: TIMED });
  assert.deepEqual(gate.shards.map(({ files, keyed }) => ({ files, keyed })), [
    { files: ['web/a.test.js', 'web/d.test.js'], keyed: false },
    { files: ['web/b.test.js', 'web/e.test.js'], keyed: false },
    { files: ['web/c.test.js'], keyed: false },
  ]);
  assert.equal(gateShards(t, { cores: 8, files: TIMED, timing: [] }).answer, null, 'a gate plan within its cores and no timing file is not split');
  const land = landShards(t, { cores: 2, files: TIMED });
  assert.deepEqual(land.shards.map(({ files, keyed }) => ({ files, keyed })), gate.shards.map(({ files, keyed }) => ({ files, keyed })));
  assert.equal(landShards(t, { cores: 8, files: TIMED }).answer.sharded, false, 'a land plan within its cores and no timing file is not split');
});

const SHARD_FILES = ['web/a.test.js', 'web/b.test.js'];
const SHARD_GREEN = head => ({ version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0 }] } });
const SIGNED = ['a'.repeat(64)];
const SHARD_RED = (head, failures, signed = true) => ({ version: 1, status: 1, gate: { source: head, green: false, phases: [{ role: 'proof', status: 1, failures, ...(signed ? { failureSignatures: SIGNED } : {}), tail: 'not ok' }] } });
/** The main-receipt lookup of a board whose main has a receipt for every file the red names; a signed case reads as one main fails the same way, an unsigned one as new. */
const mainFails = () => ({ cases }) => ({ classes: [...new Set(cases.map(row => row.file))].map(file => ({ file, owner: 'item', own: [], receipt: null, job: null })) });

/** A claimed item whose gate offered two shards; shard one posts `red`, shard two posts green, through the receipt dispatch. The last answer is `last`. */
function twoShardGate(t, { red, options, files = [] }) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit;
  const parent = `gate:${item.item_id}:main-red`;
  offerJob(board.db, { id: parent, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { entry: 'gate.js', data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree: headTree(repo.root), files } } });
  const lease = claimJob(board.db, { runner: 'r-gate', capabilities: [], now: 2 });
  const gate = { version: 1, source: head, green: false, environment: { node: process.version, platform: process.platform, arch: process.arch }, phases: [{ role: 'check', status: 0 }],
    analysis: { proofFiles: SHARD_FILES, proofCommand: 'node --test' }, proofPlan: { runner: 'node --test', cores: 1, files: SHARD_FILES } };
  const sharded = boardJobQueueCall(board, { action: 'receipt', job: parent, runner: 'r-gate', token: lease.token, receipt: { status: 0, gate } }, { mode: 'pull', now: 3, ...options });
  assert.equal(sharded.applied.outcome, 'sharded', JSON.stringify(sharded.applied));
  let last = null;
  sharded.applied.shards.forEach((shard, index) => {
    const at = 10 * (index + 1);
    const claimed = claimJob(board.db, { runner: `r-${at}`, capabilities: [], now: at });
    last = boardJobQueueCall(board, { action: 'receipt', job: shard, runner: `r-${at}`, token: claimed.token, receipt: index === 0 ? red(head) : SHARD_GREEN(head) }, { mode: 'pull', now: at + 1, ...options }).applied;
  });
  return { board, item, last };
}

test('api.io-gate.shard-main-red-settles-green: clause 1: a gate whose only red shard fails only in a file main fails settles green and notes the file as main-red [C7,#12215]', t => {
  const f = twoShardGate(t, { red: head => SHARD_RED(head, [{ file: 'web/a.test.js', name: 'loads under load' }]), options: { compareWithMain: mainFails() } });
  assert.equal(f.last.outcome, 'review', JSON.stringify(f.last));
  const notes = store.events(f.board, { itemId: f.item.item_id }).filter(row => /every red shard failed only in files main/u.test(row.event_detail ?? ''));
  assert.equal(notes.length, 1, 'one note fact');
  assert.match(notes[0].event_detail, /web\/a\.test\.js/u);
});

test('api.io-gate.shard-red-outside-main-stays-red: clause 2: a red shard with a case main does not fail, or with no comparison answer, settles red and notes no main-red [C7,#12215]', t => {
  const failures = [{ file: 'web/a.test.js', name: 'loads under load' }];
  const fresh = twoShardGate(t, { red: head => SHARD_RED(head, failures, false), options: { compareWithMain: mainFails() } });
  assert.equal(fresh.last.outcome, 'red', JSON.stringify(fresh.last));
  const none = twoShardGate(t, { red: head => SHARD_RED(head, failures), options: {} });
  assert.equal(none.last.outcome, 'red', JSON.stringify(none.last));
  for (const f of [fresh, none]) assert.equal(store.events(f.board, { itemId: f.item.item_id }).filter(row => /every red shard failed only in files main/u.test(row.event_detail ?? '')).length, 0);
});

test('api.io-gate.shard-red-in-item-diff-stays-red: clause 1: a red shard whose failing file main also fails but the item diff touches settles red and appends no main-red note [C7,#12216]', t => {
  const failures = [{ file: 'web/a.test.js', name: 'loads under load' }];
  const f = twoShardGate(t, { red: head => SHARD_RED(head, failures), options: { compareWithMain: mainFails() }, files: ['web/a.test.js'] });
  assert.equal(f.last.outcome, 'red', JSON.stringify(f.last));
  assert.equal(store.events(f.board, { itemId: f.item.item_id }).filter(row => /every red shard failed only in files main/u.test(row.event_detail ?? '')).length, 0, 'no main-red note');
});

const KEY = '1'.repeat(64);
const CONTEXT = 'e'.repeat(64);
const proofRow = (file, status, inputKey = KEY) => ({ file, inputKey, command: 'proof', context: CONTEXT, status });

test('api.io-gate.shard-offer-ledger-hits-and-misses: clause 1: a shard offer carries the ledger hit for a file with a recorded pass and a reason none, red or changed for each other file [C7,P7]', t => {
  let reasons;
  const seed = db => { recordTestResults(db, { receipt: 'r1', origin: 'fixture', rows: [proofRow('web/a.test.js', 'pass'), proofRow('web/b.test.js', 'fail'), proofRow('web/b.test.js', 'pass', '2'.repeat(64)), proofRow('web/b.test.js', 'fail', '2'.repeat(64))] });
    reasons = ledgerMissReasons(db, ['web/a.test.js', 'web/b.test.js', 'web/c.test.js']); };
  const [first, second] = shardData(t, undefined, seed);
  // Shard 1 holds a (a recorded pass: a hit) and c (no row at all); shard 2 holds b (a fail and a pass shadowed by a fail: red).
  assert.deepEqual(first.files, ['web/a.test.js', 'web/c.test.js']);
  assert.deepEqual(first.ledger.files, [['web/a.test.js', KEY, 0]]);
  assert.deepEqual(first.ledger.contexts, [CONTEXT]);
  assert.deepEqual(first.ledger.reasons, { 'web/c.test.js': 'none' });
  assert.deepEqual(second.ledger.reasons, { 'web/b.test.js': 'red' });
  assert.equal(second.ledger.files, undefined, 'a shard without a hit hands its runner no hit list');
  // A file with a recorded pass that the runner still misses reads changed: its input key moved.
  assert.deepEqual(reasons, { 'web/a.test.js': 'changed', 'web/b.test.js': 'red', 'web/c.test.js': 'none' });
});

test('api.io-gate.shard-offer-ledger-hits-and-misses: clause 2: with no ledger rows for any file of the shard its data.shard.ledger stays absent [C7,P7]', t => {
  for (const shard of shardData(t)) assert.equal(shard.ledger, undefined);
});

test('api.io-gate.seed-window-in-sql: clause 1: with gate.seedWideMainTests on, the 24 h window is inside the seeding SQL and its query plan searches job by an index and never scans job_step [C7,P7]', t => {
  const { db } = cellBoard(t, ':memory:');
  assert.match(WIDE_SEED_SQL, /job_created >= \?/u, 'the window bound is a parameter of the SQL, not a filter over rows read');
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${WIDE_SEED_SQL}`).all(0, 10).map(row => row.detail);
  assert.ok(plan.some(line => /^SEARCH job USING (?:COVERING )?INDEX job_kind_created \(job_kind=\? AND job_created>\?\)/u.test(line)), `job is searched by the kind and created index: ${plan.join(' | ')}`);
  assert.equal(plan.some(line => /^SCAN/u.test(line)), false, `no table is scanned: ${plan.join(' | ')}`);
  assert.equal(plan.some(line => /job_step USING INDEX job_step_name_(?:at|seq)/u.test(line)), false, `job_step is read by its job key, not by name across all jobs: ${plan.join(' | ')}`);
});

test('api.io-gate.seed-claim-path-no-git: clause 1: with gate.seedWideMainTests on and main unmoved, a pull claim through boardJobQueueCall spawns no git process, and the main sha is computed once per main move [C7,P7]', t => {
  const project = cellProject(t, { real: true, config: { affectedTests: 'node --test' } });
  const board = { db: cellBoard(t, ':memory:').db, gitRoot: project.repo };
  const spawned = [];
  const counting = Object.fromEntries(['spawnSync', 'execFileSync', 'spawn'].map(name => [name, (args, options) => { spawned.push(args.join(' ')); return realGitAdapter[name](args, options); }]));
  const claim = () => withGitContractAdapter(counting, () => boardJobQueueCall(board, { action: 'claim', runner: 'r-seed', capabilities: [] }, { mode: 'pull', now: 10 * 3_600_000, seedWideMainTests: true }));
  claim();
  spawned.length = 0;
  claim();
  claim();
  assert.deepEqual(spawned, [], 'claims at an unmoved main spawn no git process');
  writeFileSync(join(project.repo, 'moved.txt'), 'moved');
  project.git(project.repo, 'add', '-A');
  project.git(project.repo, 'commit', '-qm', 'chore: move main');
  claim();
  assert.ok(spawned.length >= 1 && spawned.length <= 2, `one main move computes its sha once: ${spawned.join(' | ')}`);
  spawned.length = 0;
  claim();
  assert.deepEqual(spawned, [], 'the next claim at the moved main spawns none');
});

/** A claimed item with one unsharded gate job `parent`; `post` posts a receipt for it through the production jobs route. */
function oneGate(t, options = {}) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit;
  const parent = `gate:${item.item_id}:settle-event`;
  offerJob(board.db, { id: parent, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { entry: 'gate.js', data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree: headTree(repo.root), files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-gate', capabilities: [], now: 2 });
  const post = receipt => boardJobQueueCall(board, { action: 'receipt', job: parent, runner: 'r-gate', token: lease.token, receipt }, { mode: 'pull', now: 3, ...options }).applied;
  return { board, item, head, parent, post };
}

/** The gate_settled events of the board, as their parsed details. */
const settledEvents = board => board.db.prepare("SELECT event_detail FROM event WHERE event_kind = 'gate_settled'").all().map(row => JSON.parse(row.event_detail));

test('api.io-gate.settled-green-and-item-red: clause 1: a green and an item-red receipt posted through the jobs route each append one gate_settled event with outcome and class (green, item) and (red, item) [C7,#12314]', t => {
  const green = oneGate(t);
  const answer = green.post({ version: 1, status: 0, gate: { source: green.head, green: true, phases: [{ role: 'proof', status: 0 }] } });
  assert.equal(answer.outcome, 'review', JSON.stringify(answer));
  assert.deepEqual(settledEvents(green.board).map(({ job, outcome, class: kind }) => ({ job, outcome, class: kind })), [{ job: green.parent, outcome: 'green', class: 'item' }]);
  const red = oneGate(t);
  const failed = red.post({ version: 1, status: 1, gate: { source: red.head, green: false, phases: [{ role: 'proof', status: 1, failures: [{ file: 'web/a.test.js', name: 'loads under load' }], tail: 'not ok' }] } });
  assert.equal(failed.outcome, 'red', JSON.stringify(failed));
  assert.deepEqual(settledEvents(red.board).map(({ job, outcome, class: kind }) => ({ job, outcome, class: kind })), [{ job: red.parent, outcome: 'red', class: 'item' }]);
});

test('api.io-gate.settled-once-per-job: clause 2: a sharded gate settled by settleDoneShardGates and re-seen by settleWaitingGates, and the same receipt applied twice, each leave exactly one gate_settled event for the job [C7,#12314]', t => {
  const sharded = twoShardGate(t, { red: SHARD_GREEN, options: {} });
  assert.equal(sharded.last.outcome, 'review', JSON.stringify(sharded.last));
  settleDoneShardGates(sharded.board);
  settleWaitingGates(sharded.board, 'main:none', { compareWithMain: mainFails() });
  assert.equal(settledEvents(sharded.board).length, 1, 'the sharded gate leaves one event');
  const again = oneGate(t);
  const receipt = { version: 1, status: 1, gate: { source: again.head, green: false, phases: [{ role: 'proof', status: 1, failures: [{ file: 'web/a.test.js', name: 'loads under load' }], tail: 'not ok' }] } };
  assert.equal(again.post(receipt).outcome, 'red');
  assert.equal(applyGateReceipt(again.board, { job: again.parent, receipt }).outcome, 'red', 'the same receipt applies a second time');
  assert.equal(settledEvents(again.board).length, 1, 'the twice-applied receipt leaves one event');
});

test('api.io-gate.settled-class-main-red-stale-infra: clause 1: receipts posted through the jobs route append gate_settled with (red, main-red) for a red only in a case main also fails, (stale, stale-base) for a gate with a newer job, and (unknown, infra) for a receipt with gate.analysis.infra [C7,#12315]', t => {
  const kinds = gate => settledEvents(gate.board).map(({ job, outcome, class: kind }) => ({ job, outcome, class: kind }));
  const main = oneGate(t, { compareWithMain: mainFails() });
  const answer = main.post({ version: 1, status: 1, gate: { source: main.head, green: false, phases: [{ role: 'proof', status: 1, failures: [{ file: 'web/a.test.js', name: 'loads under load' }], failureSignatures: SIGNED, tail: 'not ok' }] } });
  assert.equal(answer.outcome, 'review', JSON.stringify(answer));
  assert.ok('mainOwned' in answer, 'the settle names the red as main-owned');
  assert.deepEqual(kinds(main), [{ job: main.parent, outcome: 'red', class: 'main-red' }]);
  const stale = oneGate(t);
  offerJob(stale.board.db, { id: `gate:${stale.item.item_id}:newer`, kind: 'gate', needs: [], item: stale.item.item_id, candidate: stale.head, base: stale.head, now: 2, request: { run: ['true'], input: { entry: 'gate.js', data: {} } } });
  const late = stale.post({ version: 1, status: 0, gate: { source: stale.head, green: true, phases: [{ role: 'proof', status: 0 }] } });
  assert.equal(late.outcome, 'stale', JSON.stringify(late));
  assert.deepEqual(kinds(stale), [{ job: stale.parent, outcome: 'stale', class: 'stale-base' }]);
  const infra = oneGate(t);
  infra.post({ version: 1, status: 1, gate: { source: infra.head, green: false, analysis: { infra: 'the runner lost its checkout' }, phases: [{ role: 'proof', status: 1, failures: [], tail: 'not ok' }] } });
  assert.deepEqual(kinds(infra), [{ job: infra.parent, outcome: 'unknown', class: 'infra' }]);
});
