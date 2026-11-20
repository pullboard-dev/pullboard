/** A gate red only in proof files main fails at the same input key settles for review, behind a port off by default [C7,P7,#12130]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { headTree } from '../../../../git/index.js';
import { createJob } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';
import * as store from '../../../../store/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { settleWaitingGates } from '../../../src/io/gate.js';
import { writeMainRedFiles } from '../../../src/io/gate/main-red-files.js';

const FILES = ['web/a.test.js', 'web/b.test.js', 'web/c.test.js'];
const ENVIRONMENT = { node: process.version, platform: process.platform, arch: process.arch };
const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const RED = { file: 'web/a.test.js', name: 'loads the page' };
/** Main has a receipt for each file and fails none of its cases the same way: by case, every red reads as the item's own. */
const NEW_AGAINST_MAIN = ({ cases }) => ({ classes: [...new Set(cases.map(row => row.file))].map(file => ({ file, owner: 'item', own: [], receipt: null, job: null })) });
/** Main has no receipt for any file yet: every red reads unknown. */
const MAIN_UNKNOWN = ({ cases }) => ({ classes: [...new Set(cases.map(row => row.file))].map(file => ({ file, owner: 'unknown', own: [], receipt: null, job: null })) });

const green = head => ({ version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0 }] } });
/** A red shard whose proof ledger keys the failing file at `key`. */
const red = (head, { key = KEY, role = 'proof' } = {}) => ({ version: 1, status: 1, gate: { source: head, green: false,
  phases: [{ role, status: 1, failures: [RED], tail: 'not ok', ledger: { contexts: ['node'], files: [[RED.file, key, 0, 'fail']] } }] } });

/** A red shard that names its failing case only in errors[], with failures[] empty, as most real shard receipts do. */
const errorsOnlyRed = head => ({ version: 1, status: 1, gate: { source: head, green: false,
  phases: [{ role: 'proof', status: 1, failures: [], errors: [RED], errorCount: 1, tail: 'not ok', ledger: { contexts: ['node'], files: [[RED.file, KEY, 0, 'fail']] } }] } });

/** A finished main-test job holding main's keyed receipt for `file` at `inputKey`. */
function mainReceipt(board, { id, main, file = RED.file, inputKey = KEY, verdict = 'red', at = 5 }) {
  createJob(board.db, { id, kind: 'main-test', candidate: main, base: main, now: at });
  writeStep(board.db, id, 'receipt', { id, tree: 't'.repeat(40), file, command: 'node --test', verdict, failing: verdict === 'red' ? [RED.name] : [], signatures: [], main, at, inputKey }, { seq: 0, now: at });
}

/**
 * A claimed item whose gate passed its check and offered three shards; the first posts `first`, the rest green, and the
 * last post's result comes back as `last`. `before` runs once the shards are offered, before any posts.
 */
function shardedGate(t, { first = head => red(head), options = {}, before = () => {} } = {}) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit, tree = headTree(repo.root);
  const parent = `gate:${item.item_id}:main-red`;
  offerJob(board.db, { id: parent, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { entry: 'gate.js', data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-gate', capabilities: [], now: 2 });
  const gate = { version: 1, source: head, green: false, environment: ENVIRONMENT, phases: [{ role: 'check', status: 0 }], analysis: { proofFiles: FILES, proofCommand: 'node --test' },
    proofPlan: { runner: 'node --test', cores: 1, files: FILES } };
  const sharded = boardJobQueueCall(board, { action: 'receipt', job: parent, runner: 'r-gate', token: lease.token, receipt: { status: 0, gate } }, { mode: 'pull', now: 3, ...options });
  assert.equal(sharded.applied.outcome, 'sharded', JSON.stringify(sharded.applied));
  before({ board, head });
  let last = null;
  sharded.applied.shards.forEach((shard, index) => {
    const at = 10 * (index + 1);
    const claimed = claimJob(board.db, { runner: `r-${at}`, capabilities: [], now: at });
    assert.equal(claimed?.job, shard);
    last = boardJobQueueCall(board, { action: 'receipt', job: shard, runner: `r-${at}`, token: claimed.token, receipt: index === 0 ? first(head) : green(head) }, { mode: 'pull', now: at + 1, ...options }).applied;
  });
  const settledNote = () => JSON.parse(board.db.prepare("SELECT job_step_payload AS p FROM job_step WHERE job_step_job = ? AND job_step_name = 'note:shards.settled'").get(parent)?.p ?? 'null');
  const facts = pattern => store.events(board, { itemId: item.item_id }).filter(row => pattern.test(row.event_detail ?? ''));
  return { board, item, parent, head, last, settledNote, facts };
}

const ON = { excuseMainRedFiles: true, compareWithMain: NEW_AGAINST_MAIN };

test('api.gate-main-red-files.excused-settles-review: clause 1: a sharded gate red only in a file main fails at the same input key settles for review and names the file in the reason, a fact and the settled note [C7,P7,#12130]', t => {
  const f = shardedGate(t, { options: ON, before: ({ board, head }) => mainReceipt(board, { id: 'main-test:red-a', main: head }) });
  assert.equal(f.last.outcome, 'review', JSON.stringify(f.last));
  assert.deepEqual(f.last.mainRedExcused, [RED.file]);
  assert.equal(store.getItem(f.board, f.item.item_id).item_status, 'submitted');
  assert.deepEqual(f.settledNote().mainRedExcused, [RED.file], 'the settled note names the excused file');
  const measured = f.facts(/only in files main also fails at the same inputs/u);
  assert.equal(measured.length, 1, 'one measurement fact');
  assert.match(measured[0].event_detail, /main-red file web\/a\.test\.js at input key aaaaaaaaaaaa: main-test receipt main-test:red-a red/u);
  assert.equal(f.facts(/red only in files red on main at the same inputs \(web\/a\.test\.js\)/u).length, 1, 'the submitted note names the file');
});

test('api.gate-main-red-files.listed-file-excused: clause 1: a file on the coordinator main-red list is excused by a green main receipt at its key [C7,P7,#12130]', t => {
  const f = shardedGate(t, { options: ON, before: ({ board, head }) => {
    mainReceipt(board, { id: 'main-test:green-a', main: head, verdict: 'green' });
    writeMainRedFiles(board.db, [RED.file]);
  } });
  assert.equal(f.last.outcome, 'review', JSON.stringify(f.last));
  assert.match(f.facts(/only in files main also fails at the same inputs/u)[0].event_detail, /green on main .*coordinator's main-red file list/u);
});

test('api.gate-main-red-files.errors-only-excused: clause 1: a shard red that names its case only in errors[] is excused like one named in failures[] [C7,P7,#12130]', t => {
  const f = shardedGate(t, { options: ON, first: errorsOnlyRed, before: ({ board, head }) => mainReceipt(board, { id: 'main-test:red-a', main: head }) });
  assert.equal(f.last.outcome, 'review', JSON.stringify(f.last));
  assert.deepEqual(f.last.mainRedExcused, [RED.file]);
  assert.equal(store.getItem(f.board, f.item.item_id).item_status, 'submitted');
  assert.match(f.facts(/only in files main also fails at the same inputs/u)[0].event_detail, /main-red file web\/a\.test\.js at input key aaaaaaaaaaaa: main-test receipt main-test:red-a red/u);
  const unkeyed = shardedGate(t, { options: ON, first: head => ({ ...errorsOnlyRed(head), gate: { ...errorsOnlyRed(head).gate, phases: [{ ...errorsOnlyRed(head).gate.phases[0], errors: [{ file: RED.file }] }] } }),
    before: ({ board, head }) => mainReceipt(board, { id: 'main-test:red-a', main: head }) });
  assert.notEqual(unkeyed.last.outcome, 'review', 'an errors[] row naming no case is never excused');
});

test('api.gate-main-red-files.otherwise-unchanged: clause 2: no receipt at the key, a receipt only at another key, a green unlisted receipt, a check red or the port off settles red as today [C7,P7,#12130]', t => {
  const cases = [
    ['no main receipt', {}, () => {}],
    ['a receipt at another key (the item changed what the file covers)', {}, ({ board, head }) => mainReceipt(board, { id: 'main-test:other', main: head, inputKey: OTHER_KEY })],
    ['a green receipt, file not listed', {}, ({ board, head }) => mainReceipt(board, { id: 'main-test:green', main: head, verdict: 'green' })],
    ['the port off', { excuseMainRedFiles: false }, ({ board, head }) => mainReceipt(board, { id: 'main-test:red', main: head })],
  ];
  for (const [name, options, before] of cases) {
    const f = shardedGate(t, { options: { ...ON, ...options }, before });
    assert.equal(f.last.outcome, 'red', `${name}: ${JSON.stringify(f.last)}`);
    assert.equal(f.last.mainRedExcused, undefined, name);
    assert.notEqual(store.getItem(f.board, f.item.item_id).item_status, 'submitted', name);
    assert.equal(f.settledNote().mainRedExcused, undefined, name);
  }
  const check = shardedGate(t, { options: ON, first: head => red(head, { role: 'check' }), before: ({ board, head }) => mainReceipt(board, { id: 'main-test:red', main: head }) });
  assert.notEqual(check.last.outcome, 'review', JSON.stringify(check.last));
  assert.notEqual(store.getItem(check.board, check.item.item_id).item_status, 'submitted', 'a check red is never excused');
});

test('api.gate-main-red-files.reapply-excuses: clause 3: a gate left unknown settles for review when main records a red receipt for the file at the same key [C7,P7,#12130]', t => {
  const f = shardedGate(t, { options: { excuseMainRedFiles: true, compareWithMain: MAIN_UNKNOWN } });
  assert.equal(f.last.outcome, 'unknown', JSON.stringify(f.last));
  mainReceipt(f.board, { id: 'main-test:late', main: f.head, at: 50 });
  const settled = settleWaitingGates(f.board, 'main-test:late', { compareWithMain: NEW_AGAINST_MAIN, settleOnMainReceipt: true, excuseMainRedFiles: true });
  assert.deepEqual(settled, [f.parent]);
  assert.equal(store.getItem(f.board, f.item.item_id).item_status, 'submitted');
  assert.equal(f.facts(/only in files main also fails at the same inputs/u).length, 1);
});

test('api.gate-main-red-files.reapply-port-off-stays-red: clause 3: without the port the same re-apply stays red [C7,P7,#12130]', t => {
  const f = shardedGate(t, { options: { compareWithMain: MAIN_UNKNOWN } });
  assert.equal(f.last.outcome, 'unknown', JSON.stringify(f.last));
  mainReceipt(f.board, { id: 'main-test:late', main: f.head, at: 50 });
  settleWaitingGates(f.board, 'main-test:late', { compareWithMain: NEW_AGAINST_MAIN, settleOnMainReceipt: true });
  assert.notEqual(store.getItem(f.board, f.item.item_id).item_status, 'submitted');
});
