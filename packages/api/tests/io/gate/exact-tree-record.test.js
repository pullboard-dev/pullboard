/** A sprint landing receipt records its exact-tree record with the commands digest, and landing.exactTreeCheck refuses one without a green record; steady is untouched [V38,#12179]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { createJob } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';
import * as store from '../../../../store/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerLandingJob } from '../../../index.js';

const STAMP = '2026-11-19T12:00:00.000Z';
const CONFIG = { trunk: { remote: '/trunk.git' } };
const TRUNK = 'b'.repeat(40);
const LANDED = { version: 1, status: 0, outcome: 'landed', trunk: TRUNK, landed: [7], already: [] };
const SPRINT = { static: ['sh', '-c', 'true'], testCommand: ['false'], testFiles: '\\.test\\.js$' };
const DIGEST = createHash('sha256').update(JSON.stringify({ static: SPRINT.static, testCommand: SPRINT.testCommand })).digest('hex');
const exactTree = result => ({ tree: 'a'.repeat(40), pin: 'c'.repeat(40), cells: ['web'], result });

/** Store a screen receipt as runScreenJob stores one: a screen job whose result step holds the receipt. */
function storeScreen(db, { item, commit, base, green: passed = true }) {
  const id = `screen:${commit}:-@${base}`;
  createJob(db, { id, kind: 'screen', now: 1 });
  writeStep(db, id, 'result', { result: { kind: 'screen', item, commit, digest: null, base, green: passed, trusted: true, leased: true,
    checks: { merge: 'green', static: 'green', secrets: passed ? 'green' : 'red', hooks: 'green' }, findings: passed ? [] : ['secrets: a key'] }, owner: 'fixture' }, { now: 1 });
}

/** Every SQL text the board prepares while `run` runs, with its answer. */
function prepared(board, run) {
  const prepare = board.db.prepare.bind(board.db);
  const texts = [];
  board.db.prepare = (sql) => { texts.push(sql); return prepare(sql); };
  try { return { texts, value: run() }; } finally { board.db.prepare = prepare; }
}

/** Item 7 submitted (frozen at `pace`; steady freezes none) with one land job for it offered against its commit and claimed by a runner. */
function submittedLanding(t, pace, options = {}, status = 'submitted') {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const commit = repo.commit;
  store.board_ensureCoordinator(board, repo.root);
  const builder = cellSeat(board, { lane: 'core', path: `${repo.root}/seat` }).id;
  board.db.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'landed', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  board.db.exec('INSERT INTO temp.moving VALUES (1)');
  board.db.prepare(`UPDATE item SET item_status=?, item_commit=?, item_owner=?, item_lease_until='2099-01-01T00:00:00.000Z', item_frozen=?, item_frozen_digest=?, item_built_by=? WHERE item_id=7`)
    .run(status, commit, builder, JSON.stringify(pace === 'steady' ? {} : { pace }), 'd'.repeat(64), builder);
  board.db.exec('DELETE FROM temp.moving');
  const job = offerLandingJob(board.db, { items: [{ id: 7, commit, ref: 'refs/pullboard/land/7', ...(pace === 'sprint' ? { pace } : {}) }], expect: commit, config: CONFIG, ...(pace === 'sprint' ? { sprint: SPRINT } : {}) });
  const lease = claimJob(board.db, { runner: 'r-land', capabilities: [], now: 2 });
  assert.equal(lease?.job, job.id, 'the runner pulls the offered land job');
  const post = (receipt) => boardJobQueueCall(board, { action: 'receipt', job: job.id, runner: 'r-land', token: lease.token, receipt }, { mode: 'pull', now: 3, ...options });
  const events = kind => board.db.prepare('SELECT event_detail FROM event WHERE event_kind = ? ORDER BY event_id').all(kind).map(row => JSON.parse(row.event_detail));
  const item = () => ({ ...board.db.prepare('SELECT item_status, item_merged_commit FROM item WHERE item_id = 7').get() });
  return { board, commit, post, item, events };
}


test('api.gate.exact-tree-record.records-landed-batch: clause 1: a landed receipt for a sprint item writes a landed landing_batch event carrying the receipt\'s exactTree record and the sha256 digest of the job\'s sprint commands as commandsDigest [V38,#12179]', t => {
  for (const check of [false, true]) {
    const landing = submittedLanding(t, 'sprint', { exactTreeCheck: check });
    storeScreen(landing.board.db, { item: 7, commit: landing.commit, base: landing.commit });
    const answer = landing.post({ ...LANDED, exactTree: exactTree('green') });
    assert.deepEqual(answer.applied?.merged, [7], `check ${check}: the sprint item is merged`);
    const batches = landing.events('landing_batch').map(event => event.batch);
    assert.equal(batches.length, 1, `check ${check}: one landing batch is recorded`);
    assert.equal(batches[0].state, 'landed');
    assert.deepEqual(batches[0].items, [{ id: 7 }]);
    assert.deepEqual(batches[0].exactTree, { ...exactTree('green'), commandsDigest: DIGEST }, `check ${check}: the record and the commands digest are stored`);
  }
});

test('api.gate.exact-tree-record.refuses-without-green: clause 1: with landing.exactTreeCheck on, a sprint receipt with no exactTree or a red one leaves its items unmerged, and with it off the receipt lands as before [V38,#12179]', t => {
  for (const [label, record] of [['no record', {}], ['red record', { exactTree: exactTree('red') }]]) {
    const refused = submittedLanding(t, 'sprint', { exactTreeCheck: true });
    storeScreen(refused.board.db, { item: 7, commit: refused.commit, base: refused.commit });
    const answer = refused.post({ ...LANDED, ...record });
    assert.deepEqual(answer.applied?.merged ?? [], [], `${label}: nothing is marked merged`);
    assert.equal(refused.item().item_merged_commit, null, `${label}: the item stays unmerged`);
    assert.deepEqual(refused.events('main-moved'), [], `${label}: main-moved is not written`);
    const [blocked] = refused.events('landing_batch').map(event => event.batch);
    assert.equal(blocked.state, 'blocked', `${label}: the refusal is recorded`);
    assert.equal(blocked.refusal.code, 'LAND_EXACT_TREE');

    const off = submittedLanding(t, 'sprint', { exactTreeCheck: false });
    storeScreen(off.board.db, { item: 7, commit: off.commit, base: off.commit });
    assert.deepEqual(off.post({ ...LANDED, ...record }).applied?.merged, [7], `${label}: with the check off the item lands`);
  }
});

test('api.gate.exact-tree-record.steady-unchanged: clause 2: a land receipt with only steady items writes merged and main-moved only, with the same board calls whether landing.exactTreeCheck is on or off [V38,#12179]', t => {
  const runs = [false, true].map(check => {
    const landing = submittedLanding(t, 'steady', { exactTreeCheck: check }, 'verified');
    const { texts, value } = prepared(landing.board, () => landing.post(LANDED));
    assert.deepEqual(value.applied?.merged, [7], `check ${check}: the steady item is merged`);
    assert.deepEqual(landing.events('landing_batch'), [], `check ${check}: no landing batch is written`);
    assert.equal(landing.events('main-moved').length, 1, `check ${check}: one main-moved is written`);
    return texts;
  });
  assert.deepEqual(runs[1], runs[0], 'the board calls do not depend on the setting');
  assert.ok(runs[0].every(sql => !sql.includes('landing_batch')), 'no call reads or writes a landing batch');
});
