/** A claimed item whose gate settled unknown goes to review once main's receipts excuse every red file, else stays with its builder [C7,P7,DJ2,#12569]. */
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
import { maintainUnknownGates } from '../../../src/io/gate.js';

const FILES = ['web/a.test.js', 'web/b.test.js', 'web/c.test.js'];
const ENVIRONMENT = { node: process.version, platform: process.platform, arch: process.arch };
const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const RED = { file: 'web/a.test.js', name: 'loads the page' };
/** Main has no receipt at the gate's own main for any file: every red reads unknown, as the live unknown gates do. */
const MAIN_UNKNOWN = ({ cases }) => ({ classes: [...new Set(cases.map(row => row.file))].map(file => ({ file, owner: 'unknown', own: [], receipt: null, job: null })) });
/** The live machine's ports: settle on main receipts on, the main-red file excuse off. */
const PORTS = { compareWithMain: MAIN_UNKNOWN, settleOnMainReceipt: true };

const green = head => ({ version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0 }] } });
const red = (head, key) => ({ version: 1, status: 1, gate: { source: head, green: false,
  phases: [{ role: 'proof', status: 1, failures: [RED], tail: 'not ok', ledger: { contexts: ['node'], files: [[RED.file, key, 0, 'fail']] } }] } });

/** A finished main-test job holding main's keyed receipt for `file` at `inputKey`. */
function mainReceipt(board, { id, main, file = RED.file, inputKey = KEY, verdict = 'red', at = 50 }) {
  createJob(board.db, { id, kind: 'main-test', candidate: main, base: main, now: at });
  writeStep(board.db, id, 'receipt', { id, tree: 't'.repeat(40), file, command: 'node --test', verdict, failing: verdict === 'red' ? [RED.name] : [], signatures: [], main, at, inputKey }, { seq: 0, now: at });
}

/** A claimed item whose sharded gate settled unknown: one red shard in a file main has no receipt for at the gate's main, the rest green. */
function unknownGate(t, { repo = cellRepo(t, { real: true }), board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root }), key = KEY } = {}) {
  board.gitRoot = repo.root;
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat-${item.item_id}` });
  const reviewer = cellSeat(board, { lane: 'web', path: `${repo.root}/reviewer-${item.item_id}`, family: 'openai' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit, tree = headTree(repo.root);
  const parent = `gate:${item.item_id}:unknown`;
  offerJob(board.db, { id: parent, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { entry: 'gate.js', data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-gate', capabilities: [], now: 2 });
  const gate = { version: 1, source: head, green: false, environment: ENVIRONMENT, phases: [{ role: 'check', status: 0 }], analysis: { proofFiles: FILES, proofCommand: 'node --test' },
    proofPlan: { runner: 'node --test', cores: 1, files: FILES } };
  const sharded = boardJobQueueCall(board, { action: 'receipt', job: parent, runner: 'r-gate', token: lease.token, receipt: { status: 0, gate } }, { mode: 'pull', now: 3, ...PORTS });
  assert.equal(sharded.applied.outcome, 'sharded', JSON.stringify(sharded.applied));
  let last = null;
  sharded.applied.shards.forEach((shard, index) => {
    const at = 10 * (index + 1);
    const claimed = claimJob(board.db, { runner: `r-${at}`, capabilities: [], now: at });
    last = boardJobQueueCall(board, { action: 'receipt', job: shard, runner: `r-${at}`, token: claimed.token, receipt: index === 0 ? red(head, key) : green(head) }, { mode: 'pull', now: at + 1, ...PORTS }).applied;
  });
  assert.equal(last.outcome, 'unknown', JSON.stringify(last));
  assert.equal(store.getItem(board, item.item_id).item_status, 'claimed');
  const walk = (now, after) => maintainUnknownGates(board, { now, after, ...PORTS });
  const offered = () => store.nextFor(board, { agentId: reviewer.id, lane: 'web', verify: true }).item?.item_id ?? null;
  const steps = () => board.db.prepare('SELECT job_step_id, job_step_name, job_step_seq, job_step_payload, job_step_at FROM job_step WHERE job_step_job = ? ORDER BY job_step_id').all(parent);
  const events = () => board.db.prepare('SELECT event_id, event_kind, event_by, event_detail FROM event WHERE item_id = ? ORDER BY event_id').all(item.item_id);
  return { board, repo, item, seat, parent, head, walk, offered, steps, events };
}

test('api.gate-unknown-review.hands-to-review: clause 1: a claimed item whose gate settled unknown, with every red file red on main at its unchanged input key, moves to submitted and next --verify offers it [C7,P7,#12569]', t => {
  const f = unknownGate(t);
  assert.equal(f.offered(), null, 'a claimed item is never offered for review');
  mainReceipt(f.board, { id: 'main-test:late', main: f.head });
  f.walk(100);
  assert.equal(store.getItem(f.board, f.item.item_id).item_status, 'submitted');
  assert.equal(f.offered(), f.item.item_id, 'next --verify offers the item');
});

test('api.gate-unknown-review.item-red-stays: clause 2: an unknown gate with an item-only red stays claimed by its builder [C7,P7,#12569]', t => {
  const cases = [
    ['no main receipt for the red file', () => {}],
    ['a red main receipt only at another input key (the item changed what the file covers)', f => mainReceipt(f.board, { id: 'main-test:other', main: f.head, inputKey: OTHER_KEY })],
    ['a green main receipt at the same input key', f => mainReceipt(f.board, { id: 'main-test:green', main: f.head, verdict: 'green' })],
  ];
  for (const [name, before] of cases) {
    const f = unknownGate(t);
    before(f);
    f.walk(100);
    const held = store.getItem(f.board, f.item.item_id);
    assert.equal(held.item_status, 'claimed', name);
    assert.equal(held.item_owner, f.seat.id, name);
    assert.equal(f.offered(), null, name);
  }
});

test('api.gate-unknown-review.appended-only: clause 3: the move appends a settled note and a gate_settled event naming the rule, and every earlier step and event is unchanged [C7,DJ2,#12569]', t => {
  const f = unknownGate(t);
  mainReceipt(f.board, { id: 'main-test:late', main: f.head });
  const stepsBefore = f.steps(), eventsBefore = f.events();
  f.walk(100);
  const stepsAfter = f.steps(), eventsAfter = f.events();
  assert.deepEqual(stepsAfter.slice(0, stepsBefore.length), stepsBefore, 'no earlier job step changed');
  assert.deepEqual(eventsAfter.slice(0, eventsBefore.length), eventsBefore, 'no earlier event changed');
  const notes = stepsAfter.filter(row => row.job_step_name === 'note:shards.settled').map(row => JSON.parse(row.job_step_payload));
  assert.deepEqual(notes.map(note => note.outcome), ['unknown', 'review'], 'the unknown note stays and a review note follows it');
  assert.equal(notes[1].rule, 'gate.unknownToReview');
  const settled = eventsAfter.slice(eventsBefore.length).filter(row => row.event_kind === 'gate_settled').map(row => JSON.parse(row.event_detail));
  assert.equal(settled.length, 1, 'one appended gate_settled event');
  assert.equal(settled[0].rule, 'gate.unknownToReview');
  assert.equal(settled[0].job, f.parent);
  f.walk(20_000);
  assert.equal(f.steps().length, stepsAfter.length, 'a later walk appends nothing more');
});

test('api.gate-unknown-review.claim-skips-recovery: clause 1: a runner gets a lease without looking up historical main-test evidence for unknown gates [C7,#12627]', t => {
  const f = unknownGate(t);
  mainReceipt(f.board, { id: 'main-test:old', main: f.head });
  const pending = 'gate:pending';
  offerJob(f.board.db, { id: pending, kind: 'gate', needs: [], candidate: f.head, base: f.head, now: 55,
    request: { run: ['true'], input: { entry: 'gate.js', data: {} } } });
  const queries = [];
  const prepare = f.board.db.prepare.bind(f.board.db);
  f.board.db.prepare = sql => { queries.push(sql); return prepare(sql); };
  let answer;
  try {
    answer = boardJobQueueCall(f.board, { action: 'claim', runner: 'r-pull', capabilities: [] }, { mode: 'pull', now: 100, ...PORTS });
  } finally { f.board.db.prepare = prepare; }
  assert.equal(answer.claim?.job, pending);
  assert.ok(answer.claim?.token);
  assert.deepEqual(queries.filter(sql => /MAX\(step\.job_step_id\)|\$\.inputKey/u.test(sql)), []);
  assert.equal(store.getItem(f.board, f.item.item_id).item_status, 'claimed');
});

test('api.gate-unknown-review.bounded-recovery: clause 2: one bounded maintenance page promotes matching keyed main evidence and leaves a different key claimed [C7,#12627]', t => {
  const match = unknownGate(t);
  const other = unknownGate(t, { repo: match.repo, board: match.board, key: OTHER_KEY });
  // Fill the first page, then put one more matching unknown gate past its cursor.
  for (let index = 0; index < 6; index++) {
    const item = cellItem(match.board, { lane: 'web', title: `Work without a gate ${index}` });
    const seat = cellSeat(match.board, { lane: 'web', path: `${match.repo.root}/seat-${item.item_id}` });
    cellClaim(match.board, item.item_id, seat, { root: match.repo.root });
  }
  const later = unknownGate(t, { repo: match.repo, board: match.board });
  mainReceipt(match.board, { id: 'main-test:match', main: match.head });

  const first = match.walk(100);
  assert.deepEqual(first.moved, [{ job: match.parent, item: match.item.item_id, outcome: 'review' }]);
  assert.ok(first.after > other.item.item_id && first.after < later.item.item_id);
  assert.equal(store.getItem(match.board, match.item.item_id).item_status, 'submitted');
  for (const f of [other, later]) {
    const held = store.getItem(f.board, f.item.item_id);
    assert.equal(held.item_status, 'claimed');
    assert.equal(held.item_owner, f.seat.id);
  }
  const second = match.walk(105, first.after);
  assert.deepEqual(second.moved, [{ job: later.parent, item: later.item.item_id, outcome: 'review' }]);
  assert.equal(second.after, 0);
});
