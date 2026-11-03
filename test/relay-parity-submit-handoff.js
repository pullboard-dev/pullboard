/** Genuine queued-submit observations pass the complete sealed/native reader oracle [V4,H16,A2]. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git.js';
import { mainPolicy } from '../packages/sandbox/index.js';

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
    git(root, ['add', '--', 'pullboard.json']);
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
    store.claim(board, item, { agentId, lane: box.lane, leaseMs, head: commit,
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
    const states = store.events(board, { itemId: item }).filter(event => event.event_kind === 'submit-handoff')
      .map(event => JSON.parse(event.event_detail).state);
    assert.deepEqual(states, ['queued', 'running', 'red'], 'all three real mutations carry their public event before parity coverage');
  } finally {
    try { git(box.root, ['worktree', 'remove', '--force', root]); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}
