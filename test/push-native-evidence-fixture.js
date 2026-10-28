/** Real receipt-writer/component integration, not a CLI landing or lease assurance claim [C7]. */
import { mappedWorkingSource } from '../bin/checks/scan.js';
import { executionServices } from './gate-execution-fixture.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as store from '../src/board.js';
import { git } from '../src/git.js';
import { runGate } from '../src/gate.js';
import { boardReceiptStore, readGateReceipt, receiptBinds, receiptStore } from '../src/gate-run-receipt.js';
import { gateRuns, recordGateRun } from '../src/quarantine.js';
import { recordLandingTestDefect } from '../src/landing-test-defects.js';
import { nativePushReceiptProblems as evaluateNativePushReceiptProblems } from '../src/push-native-evidence.js';
import { COORDINATOR } from '../src/config.js';
import { policyAt } from '../src/trusted-policy-read.js';

/** Exercise real native readers through the explicit dependency boundary; none is a fabricated receipt. */
function nativePushReceiptProblems(root, board, commits) {
  return evaluateNativePushReceiptProblems(root, board, commits, { getItem: store.getItem, coordinator: COORDINATOR,
    boardReceiptStore, readGateReceipt, receiptBinds, gateRuns, policyAt });
}


/** Close the real fixture database before running any admitted child workload. */
function board(root, action) {
  const opened = store.openBoard(join(root, '.git/pullboard/board.sqlite'), undefined, { isMain: true });
  try { return action(opened); } finally { store.closeBoard(opened); }
}

/** Run actual gates and record their real private receipts through the native operation. */
async function receipt(root, config, options = {}) {
  const run = await runGate(root, config, { executionServices, trustStamp: false, landing: true, agent: 'coordinator', ...options });
  const value = readGateReceipt(receiptStore(root), run.receiptId);
  assert.ok(value, run.output);
  board(root, db => recordGateRun(db, { agentId: 'coordinator', lane: 'web', receipt: value }));
  return value;
}

/** Exercise native append order, real complete audit evidence, repair links and closed-item invalidation. */
export async function assertNativePushEvidence(root) {
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  const tip = git(root, ['rev-parse', 'HEAD']);
  const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
  const batchId = randomUUID();
  const landing = await receipt(root, config);
  assert.equal(landing.green, true);
  // Empty membership is explicit component protocol setup, not invented acceptance/gate receipts.
  board(root, db => {
    store.recordLandingBatch(db, { agentId: 'coordinator', batch: {
      version: 1, id: batchId, state: 'trunk', base: tip, tip, root, branch: 'refs/heads/main',
      owner: 'coordinator-component', logPath: join(root, 'component.log'), items: [], proof: { tree, failures: [] },
    } });
    store.finishLandingBatch(db, { agentId: 'coordinator', id: batchId, tip });
  });
  assert.match(board(root, db => nativePushReceiptProblems(root, db, [tip])).join('\n'), /latest native audit/u);
  const green = await receipt(root, config, { collectAll: true, auditBatchId: batchId });
  assert.equal(green.collection.full, true);
  assert.equal(green.collection.complete, true);
  assert.deepEqual(board(root, db => nativePushReceiptProblems(root, db, [tip])), []);
  assert.match(board(root, db => nativePushReceiptProblems(root, db, ['a'.repeat(40)])).join('\n'), /lacks its exact native green landing receipt/u);
  process.env.PULLBOARD_FIXTURE_AUDIT_RED = '1';
  let red;
  try { red = await receipt(root, config, { collectAll: true, auditBatchId: batchId }); }
  finally { delete process.env.PULLBOARD_FIXTURE_AUDIT_RED; }
  assert.equal(red.green, false);
  assert.equal(red.failures.length, 1);
  assert.match(board(root, db => nativePushReceiptProblems(root, db, [tip])).join('\n'), /lacks a native open repair link/u);
  const failure = red.failures[0];
  const bytes = mappedWorkingSource(root, failure.file).body;
  const defect = board(root, db => recordLandingTestDefect(db, { agentId: 'coordinator', test: failure.file,
    hash: createHash('sha256').update(bytes).digest('hex'), blob: git(root, ['rev-parse', `${tip}:${failure.file}`]),
    trunkBlob: null, names: [failure.name], lane: 'web', batchId, branch: 'refs/heads/main', requireOpen: true }));
  assert.deepEqual(board(root, db => nativePushReceiptProblems(root, db, [tip])), []);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ ...config, gate: 'node bin/run-tests.js --test-concurrency=1' }));
  git(root, ['add', 'pullboard.json']);
  git(root, ['commit', '-q', '-m', 'chore: change future gate policy']);
  assert.deepEqual(board(root, db => nativePushReceiptProblems(root, db, [tip])), [],
    'historical receipts retain their own exact pinned policy when the current command changes');
  board(root, db => store.withdraw(db, defect.item, { agentId: 'coordinator', reason: 'component closed-repair control' }));
  assert.match(board(root, db => nativePushReceiptProblems(root, db, [tip])).join('\n'), /lacks a native open repair link/u);
}
