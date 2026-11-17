/** A sharded item gate left unknown on a missing main receipt settles when that receipt records, behind gate.settleOnMainReceipt [C7,#9057]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { headTree } from '../../../../git/index.js';
import * as jobs from '../../../../jobs/index.js';
import * as store from '../../../../store/index.js';
import { classifyGateRed } from '../../../../drive/index.js';
import { MAIN_TEST_JOB } from '../../../../drive/index.js';
import { boardJobQueueCall } from '../../../../api/index.js';
import { offerJob } from '../../../../api/index.js';
import { settleOnMainReceiptEnabled } from '../../../../config/index.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { fixtureMachineSettings } from '../../fixtures/testkit.js';

const FILE = 'web/page.test.js';
const OTHER = 'web/other.test.js';
const CASE = 'the page renders';
const COMMAND = 'node --test';
const SIGNATURE = 'a'.repeat(64);

/** The keyed main receipts the board holds, as the gate's main-red verdict reads them back. */
function mainReceipts(db) {
  return jobs.jobsOf(db, { kind: MAIN_TEST_JOB }).flatMap(job => job.steps.filter(step => step.name === 'receipt' && typeof step.payload?.tree === 'string').map(step => step.payload));
}

/**
 * A board with one claimed item whose gate ran its proof as two shards, one red on CASE of FILE, and main's receipt for
 * FILE still missing. Each queue call goes through the board's jobs route with the setting as given.
 */
function unknownShardedGate(t, settleOnMainReceipt) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const tree = headTree(repo.root);
  const main = repo.commit;
  const lookup = ({ db, cases }) => ({ classes: [...new Set(cases.map(row => row.file))].map(file => classifyGateRed(db, mainReceipts(db), { tree, file, command: COMMAND,
    reds: cases.filter(row => row.file === file).map(row => row.name) })) });
  let now = Date.now();
  const call = body => boardJobQueueCall(board, body, { mode: 'pull', now: now += 10, compareWithMain: lookup, landingKey: () => null, settleOnMainReceipt });
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const job = `gate:${item.item_id}:sharded`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: main, base: main, now: now += 10,
    request: { run: ['true'], input: { entry: 'gate.js', data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  const post = (runner, receipt) => {
    const { claim } = call({ action: 'claim', runner, capabilities: ['node22'] });
    assert.ok(claim, `${runner} claims a job`);
    return { claim, posted: call({ action: 'receipt', job: claim.job, runner, token: claim.token, receipt: receipt(claim.job) }) };
  };
  const planned = post('r-gate', () => ({ version: 1, status: 0, gate: { source: main, green: true, phases: [],
    proofPlan: { runner: COMMAND, cores: 1, files: [FILE, OTHER] } } }));
  assert.equal(planned.posted.applied.outcome, 'sharded', JSON.stringify(planned.posted.applied));
  let last = null;
  for (const runner of ['r-shard-1', 'r-shard-2']) last = post(runner, shard => shard.endsWith(':shard:1')
    ? { version: 1, status: 1, gate: { green: false, phases: [{ role: 'proof', status: 1, failures: [{ file: FILE, name: CASE }], failureSignatures: [SIGNATURE] }] } }
    : { version: 1, status: 0, gate: { green: true, phases: [{ role: 'proof', status: 0 }] } }).posted;
  assert.equal(last.applied.outcome, 'unknown', JSON.stringify(last.applied));
  assert.equal(store.getItem(board, item.item_id).item_status, 'claimed');
  /** Record main's receipt for FILE through a runner's main-test job: green, or red on CASE the same way the gate failed it. */
  const recordMain = verdict => post('r-main', () => ({ commit: main, tail: `PULLBOARD_MAIN_TEST ${JSON.stringify(verdict === 'green'
    ? { green: true, failing: [] } : { green: false, failing: [CASE], signatures: [SIGNATURE] })}\n` }));
  return { board, item: item.item_id, job, main, seat, recordMain };
}

/** The item's thread facts as show prints them. */
function facts(board, item) {
  return store.itemThread(board, item).map(fact => fact.text ?? '');
}

/** The item's submit events and the gate jobs offered for it. */
function submitsAndGates(board, item) {
  return {
    submits: board.db.prepare("SELECT event_by AS agent, event_detail AS detail FROM event WHERE item_id = ? AND event_kind = 'submit'").all(item),
    gates: board.db.prepare("SELECT COUNT(*) AS n FROM job WHERE job_kind = 'gate' AND job_item = ?").get(item).n,
  };
}

test('gate.io-main-settle-on-main-receipt.with-gate-settleonmainreceipt-on-main-s: clause 1: with gate.settleOnMainReceipt on, main\'s receipt recording green settles the unknown sharded gate red from its recorded run [C7,#9057]', { timeout: 60_000 }, // budget: one fixture repo and board, no runner process.
t => {
  const { board, item, job, recordMain } = unknownShardedGate(t, true);
  const { claim, posted } = recordMain('green');
  assert.equal(claim.kind, MAIN_TEST_JOB, 'the queued main-test job is the one a runner took');
  assert.equal(posted.applied.outcome, 'recorded', JSON.stringify(posted.applied));
  const thread = facts(board, item);
  assert.ok(thread.some(text => text.startsWith(`Gate job ${job} red at `)), 'the gate re-applied red: main passes the case, so it is the item\'s');
  assert.ok(thread.some(text => text.startsWith(`Gate job ${job} settled red when main-test job ${claim.job}`)));
  assert.equal(store.getItem(board, item).item_status, 'claimed', 'a red stays with its builder');
});

test('gate.io-main-settle-on-main-receipt.with-gate-settleonmainreceipt-on-main-s-2: clause 1: with gate.settleOnMainReceipt on, main\'s receipt recording the same red settles the unknown sharded gate green over main-owned cases [C7,#9057]', { timeout: 60_000 }, // budget: one fixture repo and board, no runner process.
t => {
  const { board, item, job, main, recordMain } = unknownShardedGate(t, true);
  const { claim } = recordMain('red');
  const thread = facts(board, item);
  assert.ok(thread.some(text => text.startsWith(`Gate job ${job} settled green when main-test job ${claim.job}`)), thread.join('\n'));
  const after = store.getItem(board, item);
  assert.equal(after.item_status, 'submitted', 'the item goes to review with no resubmit');
  assert.equal(after.item_commit, main);
});

test('gate.io-main-settle-on-main-receipt.show-names-the-settled-result-and: clause 2: show names the settled result and no new submit event is written: a red settle writes none, a green one only the gate\'s own at its candidate [C7,#9057]', { timeout: 120_000 }, // budget: two fixture repos and boards, no runner process.
t => {
  const red = unknownShardedGate(t, true);
  const before = submitsAndGates(red.board, red.item);
  red.recordMain('green');
  const shown = facts(red.board, red.item).find(text => text.startsWith(`Gate job ${red.job} settled `));
  assert.match(shown, /settled red when main-test job .* recorded main's receipt for web\/page\.test\.js; judged from the item's recorded run, with no new submit\./u);
  assert.deepEqual(submitsAndGates(red.board, red.item), before, 'no submit event and no new gate job');
  assert.equal(before.submits.length, 0);
  const green = unknownShardedGate(t, true);
  green.recordMain('red');
  const after = submitsAndGates(green.board, green.item);
  assert.equal(after.gates, 1, 'no new gate job was offered');
  assert.equal(after.submits.length, 1, 'one submit event: the gate\'s own result, applied from its recorded run');
  assert.equal(after.submits[0].agent, green.seat.id);
  assert.equal(JSON.parse(after.submits[0].detail).commit, green.main, 'at the gate\'s own candidate');
});

test('gate.io-main-settle-on-main-receipt.with-gate-settleonmainreceipt-off-the-default: clause 3: with gate.settleOnMainReceipt off (the default), the sharded gate stays unknown when main\'s receipt records, as today [C7,#9057]', { timeout: 60_000 }, // budget: one fixture repo and board, no runner process.
t => {
  const { root } = privateFixtureFiles('pullboard-settle-main-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, {});
    assert.equal(settleOnMainReceiptEnabled(), false, 'off unless the machine turns it on');
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, { gate: { settleOnMainReceipt: 'yes' } });
    assert.throws(() => settleOnMainReceiptEnabled(), /gate\.settleOnMainReceipt/u);
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
  const { board, item, job, recordMain } = unknownShardedGate(t, false);
  const { posted } = recordMain('green');
  assert.equal(posted.applied.outcome, 'recorded', 'main\'s receipt still records');
  const gateFacts = facts(board, item).filter(text => text.startsWith(`Gate job ${job} `) && !text.includes('passed its checks'));
  assert.equal(gateFacts.length, 1, gateFacts.join('\n'));
  assert.match(gateFacts[0], /unknown at .* until main's missing receipts record/u);
  assert.equal(store.getItem(board, item).item_status, 'claimed');
  assert.deepEqual(submitsAndGates(board, item).submits, []);
});
