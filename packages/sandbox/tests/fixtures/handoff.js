/** Genuine queued-submit observations pass the complete sealed/native reader oracle [V4,H16,A2]. */
import assert from 'node:assert/strict';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../../../git/index.js';
import { mainPolicy } from '../../index.js';

/** Capture a real clean registered source, then compare every reader after queue, start and red completion.
 * The refusal is labeled fixture input; no gate execution or green submission is claimed.
 */
export async function seedSubmitHandoff({ board, box, store, exercise }) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-parity-submit-'));
  const root = join(directory, 'builder');
  git(box.root, ['worktree', 'add', '--detach', root, 'HEAD']);
  try {
    // The surrounding fixture intentionally edits policy; capture its actual bytes in a clean source.
    writeFileSync(join(root, 'pullboard.json'), readFileSync(join(box.root, 'pullboard.json')));
    // One path no lane owns, so only the coordinator does; the claim below is based before it [B3,L1,V4].
    writeFileSync(join(root, 'parity-owner-wait.txt'), 'Owned by the coordinator.\n');
    git(root, ['add', '--', 'pullboard.json', 'parity-owner-wait.txt']);
    const tree = git(root, ['write-tree']);
    const parent = git(root, ['rev-parse', 'HEAD']);
    const commit = git(root, ['commit-tree', tree, '-p', parent, '-m', 'fixture: queued-submit parity source']);
    git(root, ['reset', '--hard', commit]);
    const main = mainPolicy(root).commit;
    const agentId = store.register(board, { lane: box.lane, path: root, family: 'Fixture Submit Parity Vendor' });
    const item = store.addItem(board, { by: 'coordinator', lane: box.lane,
      title: 'Queued submit reader parity', criterion: 'Real job mutations preserve complete reader parity.' });
    const text = JSON.stringify({ rows: [], policy: { version: 1, commit: main, verify: { policy: 'any', family: 'off' } } });
    const digest = createHash('sha256').update(text).digest('hex');
    const leaseMs = 3600000;
    const exitClaimKey = randomUUID();
    store.claim(board, item, { agentId, lane: box.lane, leaseMs, head: parent,
      freeze: () => ({ text, digest }), exitRules: { enabled: true, tokens: 100, calls: 10 }, exitClaimKey });
    // Synthetic numeric progress exercises projection only, never real model usage or a budget stop.
    const progress = await exercise('recordExitProgress', () => store.recordExitProgress(board,
      { agentId, item, claim: exitClaimKey, tokens: null, calls: 1 }));
    assert.deepEqual(progress, { tokens: null, calls: 1, highWater: { tokens: null, calls: 1 } });
    assert.equal(git(root, ['status', '--porcelain']), '', 'the native source sealer receives a genuinely clean checkout');
    const queued = await exercise('queueSubmitHandoff', () => store.queueSubmitHandoff(board, item,
      { agentId, job: randomUUID(), commit, tree, main, executionCommit: commit, executionTree: tree,
        digest, companionDigest: null, leaseMs }));
    assert.equal(queued?.created, true, 'a refused setup or repeated queue never counts as coverage');
    assert.equal(queued.job.state, 'queued');
    assert.equal(store.getItem(board, item).item_status, 'claimed', 'queueing is not a submission');
    const started = await exercise('startSubmitHandoff', () => store.startSubmitHandoff(board, item,
      { agentId, job: queued.job.id }));
    assert.equal(started?.started, true);
    assert.equal(started.job.state, 'running');
    const completed = await exercise('completeSubmitHandoff', () => store.completeSubmitHandoff(board, item,
      { agentId, job: queued.job.id, result: { code: 1, error: { code: 'PARITY_FIXTURE_REFUSAL',
        message: 'Synthetic refusal for native-state projection only; no gate execution.',
        next: 'Read the fixture observation; no successful submission is claimed.' } } }));
    assert.equal(completed?.state, 'red');
    assert.equal(store.getItem(board, item).item_status, 'claimed', 'a real red completion keeps the queued claim for its builder');
    assert.equal(store.getItem(board, item).item_commit, null, 'job observations never invent submitted source');
    // The same clean source is green at its exact frozen criterion and holds a path only another lane owns, so
    // it waits for that owner. The stored receipt is native fixture input; no gate ran and nothing is submitted.
    const receipt = { version: 2, id: randomUUID(), kind: 'submit', head: commit, tree, main,
      command: 'c'.repeat(64), green: true, failures: [], load: null, at: board.clock.now().toISOString(),
      proof: { item, frozenDigest: digest, seat: agentId, environment: null, runner: null, exitCode: 0,
        counts: { passed: 1, failed: 0, skipped: 0 }, durationMs: 1, sourceClean: true } };
    const folder = join(box.root, '.git', 'pullboard', 'gate-receipts');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${receipt.id}.json`), board.runtimePorts.sourceAdvanceReceipts.receiptBody(receipt));
    store.recordProofRun(board, { agentId, itemId: item, receiptId: receipt.id });
    const wait = await exercise('deferOwnership', () => store.deferOwnership(board, item,
      { root, agentId, commit, tree, main, receiptIds: [receipt.id] }));
    assert.deepEqual(wait?.paths, ['parity-owner-wait.txt'], 'a refused setup never counts as ownership parity');
    assert.deepEqual(wait.owners, ['coordinator']);
    assert.equal(store.getItem(board, item).item_status, 'open', 'routing frees the builder');
    assert.equal(store.getItem(board, item).item_commit, null, 'owner waiting is never a submission');
    const states = store.events(board, { itemId: item }).filter(event => event.event_kind === 'submit-handoff')
      .map(event => JSON.parse(event.event_detail).state);
    assert.deepEqual(states, ['queued', 'running', 'red'], 'all three real mutations carry their public event before parity coverage');
  } finally {
    try { git(box.root, ['worktree', 'remove', '--force', root]); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}
