/** Exercise collision-free batches against real private Git, hooks, board settings and remotes [B3,R3,R1]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import * as store from '../../index.js';

/** Same-path independent edits split only when enabled; a disjoint item still rides the first batch. */
export function assertCollisionFreeLanding({ landProject, itemWorktree, submitItem, acceptItem, json, onBoard }) {
  for (const enabled of [false, true]) {
    const box = landProject();
    const shared = 'web/land-1.test.js';
    mkdirSync(join(box.repo, 'web'), { recursive: true });
    writeFileSync(join(box.repo, shared), '// BASE first\n// unchanged middle\n// BASE last\n');
    box.git(box.repo, 'add', shared);
    box.git(box.repo, 'commit', '-q', '-m', 'test: shared landing base [G1]');
    const entries = [itemWorktree(box, 1, shared), itemWorktree(box, 2, shared), itemWorktree(box, 3)];
    submitItem(box, entries[0], '// A first\n// unchanged middle\n// BASE last\n');
    submitItem(box, entries[1], '// BASE first\n// unchanged middle\n// B last\n');
    submitItem(box, entries[2]);
    for (const entry of entries) acceptItem(box, entry);
    if (enabled) onBoard(box, board => store.setLineSetting(board, { agentId: 'coordinator', key: 'collisionFreeBatch', value: true,
      reason: 'private same-path accepted items must land separately', window: { accepted: 3 } }));
    else onBoard(box, board => assert.equal(store.lineSettings(board).collisionFreeBatch ?? false, false));
    const first = json(box, box.repo, 'land', '--max', '3');
    assert.deepEqual(first.landed, (enabled ? [entries[0], entries[2]] : entries).map(entry => entry.item));
    assert.deepEqual(first.conflicts, []);
    assert.deepEqual(first.culprits, []);
    if (enabled) {
      assert.equal(json(box, box.repo, 'show', String(entries[1].item)).item_status, 'verified', 'deferred overlap keeps its verdict');
      const notices = json(box, box.repo, 'inbox').shouts.filter(row => row.shout_from === 'landing' && row.shout_to === `item:${entries[1].item}`);
      assert.equal(notices.length, 1, 'the deferred item and its reviewer receive one landed-batch notice');
      assert.match(notices[0].shout_text, /fresh merge-only re-accept.*no builder cycle or reopening/u);
      // A stale same-path review is never exempted: the independent private coordinator composes
      // and re-accepts the new trunk, without changing the submitted commit or asking its builder.
      const retainedCommit = json(box, box.repo, 'show', String(entries[1].item)).item_commit;
      box.git(box.repo, 'switch', '-q', '--detach', entries[1].commit);
      box.git(box.repo, 'merge', '--no-edit', 'main');
      const reviewed = { ...entries[1], commit: box.git(box.repo, 'rev-parse', 'HEAD') };
      box.git(box.repo, 'switch', '-q', 'main');
      acceptItem(box, reviewed);
      assert.equal(json(box, box.repo, 'show', String(entries[1].item)).item_commit, retainedCommit, 'merge-only review preserves the builder submission');
      const second = json(box, box.repo, 'land', '--max', '3');
      assert.deepEqual(second.landed, [entries[1].item], 'the deferred item leads the next batch');
      assert.deepEqual(second.conflicts, []);
      assert.deepEqual(second.culprits, []);
      onBoard(box, board => assert.equal(store.allShouts(board).filter(row => row.shout_from === 'landing' && row.shout_to === `item:${entries[1].item}`).length, 1, 'later landing does not repeat the notice'));
    }
    for (const entry of entries) {
      const item = json(box, box.repo, 'show', String(entry.item));
      assert.equal(item.item_status, 'verified');
      assert.ok(item.item_merged_commit, 'every accepted item lands without reopening');
    }
    assert.equal(box.git(box.repo, 'show', 'main:' + shared), '// A first\n// unchanged middle\n// B last');
    assert.equal(box.git(box.remote, 'rev-parse', 'main'), box.git(box.repo, 'rev-parse', 'main'), 'the actual gated tip was pushed');
  }
}

/** A fresh re-accept must not let newly accepted disjoint work jump a deferred item. */
export function assertDeferredLandingPriority({ landProject, itemWorktree, submitItem, acceptItem, json, onBoard }) {
  const box = landProject();
  const shared = 'web/land-1.test.js';
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, shared), '// BASE first\n// unchanged middle\n// BASE last\n');
  box.git(box.repo, 'add', shared);
  box.git(box.repo, 'commit', '-q', '-m', 'test: deferred landing base [G1]');
  const entries = [itemWorktree(box, 1, shared), itemWorktree(box, 2, shared), itemWorktree(box, 3)];
  submitItem(box, entries[0], '// A first\n// unchanged middle\n// BASE last\n');
  submitItem(box, entries[1], '// BASE first\n// unchanged middle\n// B last\n');
  submitItem(box, entries[2]);
  for (const entry of entries) acceptItem(box, entry);
  onBoard(box, board => store.setLineSetting(board, { agentId: 'coordinator', key: 'collisionFreeBatch', value: true,
    reason: 'private deferred item retains its queue place', window: { accepted: 3 } }));
  const first = json(box, box.repo, 'land', '--max', '3');
  assert.deepEqual(first.landed, [entries[0].item, entries[2].item]);
  const arrival = itemWorktree(box, 4);
  submitItem(box, arrival);
  acceptItem(box, arrival);
  box.git(box.repo, 'switch', '-q', '--detach', entries[1].commit);
  box.git(box.repo, 'merge', '--no-edit', 'main');
  const reviewed = { ...entries[1], commit: box.git(box.repo, 'rev-parse', 'HEAD') };
  box.git(box.repo, 'switch', '-q', 'main');
  acceptItem(box, reviewed);
  const next = json(box, box.repo, 'land', '--max', '1');
  assert.deepEqual(next.landed, [entries[1].item], 'merge-only reaccept retains the deferred item ahead of the newer acceptance');
  const last = json(box, box.repo, 'land', '--max', '1');
  assert.deepEqual(last.landed, [arrival.item]);
  for (const entry of [...entries, arrival]) {
    const item = json(box, box.repo, 'show', String(entry.item));
    assert.equal(item.item_status, 'verified');
    assert.ok(item.item_merged_commit);
  }
}
