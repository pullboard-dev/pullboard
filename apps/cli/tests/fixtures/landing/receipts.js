/** @pullboard-test-input apps/cli/src/io/landing/audit.js apps/lib/src/logic/native.js packages/codemap/data/plan/cells.json packages/landing/index.js packages/runners/index.js */
/** Shared private-fixture helpers for the native train receipt journeys [C7]. */
import { receiptBinds } from '../../../../../packages/gate/index.js';
import { gateRuns } from '../../../../../packages/flakes/index.js';
import { COORDINATOR } from '../../../../../packages/config/index.js';
import { policyAt } from '../../../../../packages/sandbox/index.js';
import { copyCommittedPackageFiles } from '../copy.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import {
  openBoard,
  recordGateRun,
} from '../../../../lib/index.js';
import { boardReceiptStore } from '../../../../../packages/gate/index.js';
import { readGateReceipt } from '../../../../../packages/gate/index.js';
import { receiptStore } from '../../../../../packages/gate/index.js';
import { nativePushReceiptProblems as evaluateNativePushReceipts } from '../../../../../packages/git/index.js';
import { runFixtureChild } from '../child.js';
import { createE2eHelpers } from '../e2e.js';
import { submitFixture } from '../board/submit.js';
import { mainAuditKey } from '../../../../../packages/gate/index.js';


/** Exercise the production evaluator with its genuine native store, policy and receipt providers. */
export function nativePushReceiptProblems(root, board, commits) {
  return evaluateNativePushReceipts(root, board, commits, { boardReceiptStore, readGateReceipt, receiptBinds,
    gateRuns, getItem: store.getItem, coordinator: COORDINATOR, policyAt });
}

/** Require the exact native release job and its source-bound full collection receipt. */
function completedAudit(box, activation, batch, token) {
  const directory = join(box.repo, '.git/pullboard/main-audits');
  const identity = { board: activation.board, batchId: batch.id, tip: batch.tip, tree: batch.proof.tree };
  const key = `${mainAuditKey(identity)}-release-${token}`;
  const path = join(directory, `${key}.json`);
  assert.ok(existsSync(path), 'the explicit release worker produced its own job');
  const job = JSON.parse(readFileSync(path, 'utf8'));
  for (const [name, value] of Object.entries(identity)) assert.equal(job[name], value);
  assert.equal(job.state, 'complete', JSON.stringify(job));
  assert.equal(job.green, true);
  assert.equal(job.cleanupVerified, true);
  for (const name of ['cleanupNeeded', 'incomplete', 'error']) assert.equal(job[name], undefined, JSON.stringify(job));
  const receipt = readGateReceipt(receiptStore(box.repo), job.receiptId);
  assert.ok(receipt, 'completion retains a real native receipt');
  assert.equal(receipt.kind, 'land');
  assert.equal(receipt.head, batch.tip);
  assert.equal(receipt.tree, batch.proof.tree);
  assert.equal(receipt.green, true);
  assert.equal(receipt.collection?.batchId, batch.id);
  assert.equal(receipt.collection.complete, true);
  assert.equal(receipt.collection.full, true);
  assert.ok(receipt.collection.plannedFiles > 0);
  assert.equal(existsSync(join(directory, `source-${key}`)), false, 'the native worker removed its owned source');
}

/** Bootstrap unknown cadence explicitly, then await the native producer before removing its fixture. */
async function finishAudits(box, waitFor) {
  const directory = join(box.repo, '.git/pullboard/main-audits');
  const activationPath = join(directory, 'activation.json');
  if (!existsSync(activationPath)) return false;
  const activation = JSON.parse(readFileSync(activationPath, 'utf8'));
  const pending = onBoard(box, board => store.events(board).filter(event => event.event_id > activation.afterEventId
    && event.event_kind === 'landing_batch' && JSON.parse(event.event_detail).batch.state === 'landed')
    .map(event => JSON.parse(event.event_detail).batch));
  if (!pending.length) return false;
  const owner = join(directory, 'owner.json');
  // A scheduled nudge with unknown cadence deliberately does no work. A release audit is explicit.
  await waitFor(() => !existsSync(owner), 'the prior native audit owner drains', 60_000); // budget: hang-only cleanup ceiling.
  for (const batch of pending) {
    if (!box.auditTokens.has(batch.id)) {
      assert.equal(batch.id, pending.at(-1).id, 'each earlier landing was audited before the next landing');
      const token = randomUUID();
      const env = { ...box.env };
      // This independent private fixture worker acquires its own native slots, as the production nudge does.
      for (const name of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN',
        'PULLBOARD_BROWSER_SLOT_HELD', 'PULLBOARD_CHECKOUT_SESSION_TOKEN']) delete env[name];
      box.auditTokens.set(batch.id, token); // A failed or unobserved job is inspected, never silently executed again.
      const result = runFixtureChild(process.execPath, [join(box.repo, 'apps/cli/src/io/landing/audit.js'), box.repo, token, '--release'],
        { cwd: box.repo, env, encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    }
    completedAudit(box, activation, batch, box.auditTokens.get(batch.id));
  }
  await waitFor(() => !existsSync(owner), 'the real audits and owned cleanup finish', 60_000); // budget: hang-only cleanup ceiling.
  return true;
}

/** Read or mutate only this test's private real SQLite board. */
export function onBoard(box, action) {
  // @pullboard-board-file journey: inspect the private fixture board shared with real push and native audit flows
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { isMain: true });
  try { return action(board); } finally { store.closeBoard(board); }
}

/** Prepare real private source and policy; all gate receipts are produced by actual native executions. */
export function fixture(t, required = true) {
  const helpers = createE2eHelpers();
  const box = helpers.project('node packages/gate/src/io/run/tests.js', undefined, { withWorktree: false });
  box.auditTokens = new Map();
  t.after(async () => { await finishAudits(box, helpers.waitFor); helpers.cleanup(); });
  delete box.env.NODE_TEST_CONTEXT;
  // A root installation retains a single real package scope for the production import-closure audit.
  copyCommittedPackageFiles(box, join(import.meta.dirname, '../../../../..'));
  // Remove only the copied repository's own cells plan: its rows name Pullboard's unshipped tests, so a landing here
  // would refuse LAND_PLAN_UNPLACED before the receipt rules under test. The shipped modules stay intact.
  rmSync(join(box.repo, 'packages/codemap/data/plan/cells.json'), { force: true });
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/train.test.js'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('the actual train body [C7]',()=>assert.notEqual(process.env.TRAIN_RED,'1'));\n");
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config,
    landing: { perItem: false, manualOverride: true, publish: 'separate', requireReceipts: required }, pushReceiptCheck: { smoke: 'node -e ""' } }));
  box.git(box.repo, 'add', '--', 'package.json', 'pullboard.json', 'web/train.test.js', 'packages/codemap/data/plan/cells.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: prepare native train fixture');
  const base = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  return { ...box, base, waitFor: helpers.waitFor };
}

/** Establish synthetic lifecycle acceptance while retaining a genuine committed item source, not invented gate proof. */
export function verifiedItem(box, number, root = box.repo) {
  const before = box.git(root, 'rev-parse', 'HEAD').trim();
  const setup = onBoard(box, board => {
    const actor = store.register(board, { lane: 'web', path: join(box.dir, `private-builder-${number}`) });
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: `Train fixture ${number}`, criterion: 'Retain the committed item.', specIds: ['G1'] });
    const frozen = JSON.stringify({ criterion: 'Retain the committed item.' });
    const digest = createHash('sha256').update(frozen).digest('hex');
    store.claim(board, id, { agentId: actor, lane: 'web', leaseMs: 3_600_000, head: before, freeze: () => ({ text: frozen, digest }) });
    return { actor, id, digest };
  });
  writeFileSync(join(root, `web/item-${number}.txt`), `actual item ${number}\n`);
  box.git(root, 'add', '-A');
  // A side checkout is no joined seat; this synthetic setup commit skips its hooks, as the shipped-source commits do.
  const hooks = root === box.repo ? [] : ['-c', 'core.hooksPath=/dev/null'];
  box.git(root, ...hooks, 'commit', '-q', '-m', `feat(web): retain fixture item ${number} [G1]`);
  const commit = box.git(root, 'rev-parse', 'HEAD').trim();
  const tree = box.git(root, 'rev-parse', 'HEAD^{tree}').trim();
  onBoard(box, board => {
    submitFixture(board, setup.id, { agentId: setup.actor, commit, tree });
    store.verify(board, setup.id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'synthetic lifecycle setup, not a gate claim', head: commit, digest: setup.digest, policy: 'any' });
  });
  return setup.id;
}

/**
 * A linked checkout detached at a commit, for item commits off the trunk.
 * Why: a detached primary checkout has no trunk policy, so board writes there refuse NO_POLICY by design (81e1725d67).
 */
export function sideCheckout(box, commit, name = 'side') {
  const path = join(box.dir, `train-${name}`);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, commit);
  return path;
}

/** Produce a fresh native gate receipt through the actual public CLI. */
export function gate(box, red = false) {
  const prior = box.env.TRAIN_RED;
  if (red) {
    box.env.TRAIN_RED = '1';
    // The fixture body reads TRAIN_RED, which no test-cache key declares, so a red run must not reuse the green result.
    box.env.PULLBOARD_TEST_REUSE = '0';
  }
  let result;
  try { result = box.run(box.repo, 'gate', '--landing', '--receipt', '--json'); }
  finally {
    if (prior === undefined) delete box.env.TRAIN_RED; else box.env.TRAIN_RED = prior;
    delete box.env.PULLBOARD_TEST_REUSE;
  }
  assert.equal(result.code, red ? 1 : 0, `${result.out}${result.err}`);
  const value = JSON.parse(result.out);
  assert.ok(value.receiptId, result.out);
  return readGateReceipt(receiptStore(box.repo), value.receiptId);
}

/** Execute a real complete collection audit and record its native result through the public board operation. */
export async function audit(box, batch) {
  const batchId = typeof batch === 'string' ? batch : batch.id;
  const latest = onBoard(box, board => store.events(board).filter(event => event.event_kind === 'landing_batch'
    && JSON.parse(event.event_detail).batch.state === 'landed').at(-1));
  assert.equal(JSON.parse(latest.event_detail).batch.id, batchId, 'the explicit full audit covers the requested latest landing');
  if (await finishAudits(box, box.waitFor)) return;
  const source = `import {runGate} from ${JSON.stringify(new URL('../../../../../packages/gate/index.js', import.meta.url).href)};
import * as store from ${JSON.stringify(new URL('../../../../../packages/store/index.js', import.meta.url).href)};
import {openBoard,recordGateRun} from ${JSON.stringify(new URL("../../../../lib/src/logic/native.js", import.meta.url).href)};
import {readGateReceipt,receiptStore} from ${JSON.stringify(new URL('../../../../../packages/gate/index.js', import.meta.url).href)};
import { runnerExecutionServices } from ${JSON.stringify(new URL('../../../../../packages/runners/index.js', import.meta.url).href)};
import { landingExecutionServices } from ${JSON.stringify(new URL('../../../../../packages/landing/index.js', import.meta.url).href)};
import { readFileSync } from 'node:fs';
const root=process.cwd(); const run=await runGate(root,JSON.parse(readFileSync('pullboard.json','utf8')),{executionServices:{runners:runnerExecutionServices(),landing:landingExecutionServices()},trustStamp:false,landing:true,collectAll:true,auditBatchId:${JSON.stringify(batchId)},agent:'coordinator'});
const receipt=readGateReceipt(receiptStore(root),run.receiptId); if(!receipt?.collection?.complete||!receipt.collection.full)throw new Error(run.output);
const db=openBoard('.git/pullboard/board.sqlite',undefined,{isMain:true});try{recordGateRun(db,{agentId:'coordinator',receipt,lane:'web'});}finally{store.closeBoard(db);}console.log(receipt.id);`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}
