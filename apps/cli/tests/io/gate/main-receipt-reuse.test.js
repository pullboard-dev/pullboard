/** A gate reads main's receipt from an earlier main whose inputs to the test file are the same; a missing one reads unknown [C7,SC11]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../../packages/board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellItem } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../packages/store/tests/fixtures/cell.js';
import { CELL_CONFIG } from '../../../../../packages/store/tests/fixtures/cell.js';
import * as store from '../../../../../packages/store/index.js';
import { classifyGateRed } from '../../../../../packages/drive/index.js';
import { testActionKeys } from '../../../../../packages/gate/index.js';
import { mainReceipts } from '../../../../../packages/landing/index.js';
import { recordMainTestReceipt } from '../../../../../packages/landing/index.js';
import { boardJobQueueCall } from '../../../../../packages/api/index.js';
import { claimJob } from '../../../../../packages/api/index.js';
import { compareGateWithMain } from '../../../../../packages/api/index.js';
import { offerJob } from '../../../../../packages/api/index.js';

const FILE = 'web/page.test.js';
const CASE = 'the page renders';

/**
 * A repository whose main moves twice after `earlier`: `moved` changes only a file outside the test's import closure,
 * `changed` then edits the module the test imports. The test file's input key is read at each, as the runner keys it.
 */
async function movingMain(t) {
  const repo = cellRepo(t, { config: { ...CELL_CONFIG, affectedTests: 'node --test' } });
  repo.put('package.json', '{ "type": "module" }\n');
  repo.put('web/lib.js', 'export const ready = false;\n');
  repo.put(FILE, `import { test } from 'node:test';\nimport { ready } from './lib.js';\ntest('${CASE}', () => { if (!ready) throw new Error('not ready'); });\n`);
  repo.put('notes.txt', '0\n');
  const earlier = repo.commitAll();
  repo.put('notes.txt', '1\n');
  const moved = repo.commitAll();
  repo.put('web/lib.js', 'export const ready = 0;\n');
  const changed = repo.commitAll();
  const keys = {};
  for (const [name, commit] of Object.entries({ earlier, moved, changed })) {
    keys[name] = (await testActionKeys(repo.root, { commit, files: [FILE] })).get(FILE)?.inputKey;
  }
  return { repo, earlier, moved, changed, keys };
}

/** The gate's main-receipt lookup, composed from the same cells as the CLI's criterionMainReceipts. */
function receiptLookup({ root, db, main, cases, inputKeys }) {
  const files = [...new Set(cases.map(row => row.file))];
  const known = mainReceipts(root, main, files, { inputKeys });
  if (!known) return null;
  return { classes: files.map(file => classifyGateRed(db, known.receipts, { tree: known.tree, file, command: known.command,
    reds: cases.filter(row => row.file === file).map(row => row.name) })) };
}

/** A red gate receipt for one case of FILE, its proof-ledger row keyed as the runner's cache frame keyed it. */
function redReceipt(head, inputKey) {
  return { version: 1, status: 1, gate: { source: head, green: false, phases: [{ role: 'proof', status: 1,
    failures: [{ file: FILE, name: CASE }], failureSignatures: ['a'.repeat(64)],
    ledger: { contexts: ['e'.repeat(64)], files: [[FILE, inputKey, 0, 'fail']], omitted: 0 } }] } };
}

/** How many main-test jobs the board holds. */
function mainTests(board) {
  return board.db.prepare("SELECT COUNT(*) AS n FROM job WHERE job_kind = 'main-test'").get().n;
}

test('cli.io-gate-main-receipt-reuse.a-main-that-moved-only-outside-the: clause 1: a main that moved only outside the test file\'s import closure answers from the earlier main\'s receipt and queues no job [C7,SC11]', { timeout: 60_000 }, // budget: one fixture repo, three input-key reads, no runner.
async t => {
  const { repo, earlier, moved, keys } = await movingMain(t);
  assert.match(keys.earlier ?? '', /^[0-9a-f]{64}$/u, 'the test file has an input key');
  assert.equal(keys.moved, keys.earlier, 'a move outside the closure keeps the key');
  assert.ok(recordMainTestReceipt(repo.root, { main: earlier, file: FILE, verdict: 'green', job: 'main-test-earlier', inputKey: keys.earlier }));
  const board = cellBoard(t, repo.boardFile, undefined, { gitRoot: repo.root });
  board.gitRoot = repo.root;
  const compared = compareGateWithMain(board, redReceipt(moved, keys.moved), moved, receiptLookup);
  assert.deepEqual(compared.cases.map(row => [row.file, row.name, row.onMain, row.receipt]), [[FILE, CASE, false, 'main-test-earlier']],
    'the case is judged against the earlier main\'s receipt: main passes it, so it is the change\'s own');
  assert.deepEqual(compared.jobs, []);
  assert.equal(mainTests(board), 0, 'no main-test job was queued');
});

test('cli.io-gate-main-receipt-reuse.a-main-that-changed-a-module-inside: clause 2: a main that changed a module inside the closure does not reuse the earlier receipt [C7,SC11]', { timeout: 60_000 }, // budget: one fixture repo, three input-key reads, no runner.
async t => {
  const { repo, earlier, changed, keys } = await movingMain(t);
  assert.notEqual(keys.changed, keys.earlier, 'editing an imported module changes the key');
  recordMainTestReceipt(repo.root, { main: earlier, file: FILE, verdict: 'green', job: 'main-test-earlier', inputKey: keys.earlier });
  const board = cellBoard(t, repo.boardFile, undefined, { gitRoot: repo.root });
  board.gitRoot = repo.root;
  const compared = compareGateWithMain(board, redReceipt(changed, keys.changed), changed, receiptLookup);
  assert.deepEqual(compared.cases.map(row => [row.onMain, row.receipt]), [[null, null]], 'no receipt answers: main\'s is missing');
  assert.equal(compared.jobs.length, 1, 'the main-test job for this main is queued instead');
  assert.equal(mainTests(board), 1);
});

test('cli.io-gate-main-receipt-reuse.a-gate-red-only-where-main-s: clause 3: a gate red only where main\'s receipt is still missing is recorded as unknown, not red, and keeps the item claimed [C7]', { timeout: 60_000 }, // budget: one fixture repo, three input-key reads, no runner.
async t => {
  const { repo, changed, keys } = await movingMain(t);
  const board = cellBoard(t, repo.boardFile, undefined, { gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const job = `gate:${item.item_id}:unknown`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: changed, base: changed, now: 1,
    request: { run: ['true'], input: { data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree: '', files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-unknown', capabilities: [], now: 2 });
  const posted = boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-unknown', token: lease.token, receipt: redReceipt(changed, keys.changed) },
    { mode: 'pull', now: 3, compareWithMain: receiptLookup });
  assert.equal(posted.applied.outcome, 'unknown', JSON.stringify(posted.applied));
  const facts = store.itemThread(board, item.item_id).map(fact => fact.text ?? '');
  const fact = facts.find(text => text.startsWith(`Gate job ${job} `));
  assert.match(fact, new RegExp(`^Gate job ${job} unknown at ${changed.slice(0, 12)}`, 'u'));
  assert.match(fact, /main receipt missing: proof web\/page\.test\.js \(the page renders\)/u);
  assert.ok(!facts.some(text => text.startsWith(`Gate job ${job} red`)), 'nothing records it red');
  assert.equal(store.getItem(board, item.item_id).item_status, 'claimed', 'the item waits with its builder for main\'s receipt');
  assert.equal(mainTests(board), 1, 'the main-test job that settles it is queued');
});
