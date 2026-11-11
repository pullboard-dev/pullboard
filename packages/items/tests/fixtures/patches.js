/** Real native companion mutations pass the complete HTTP/pinned API2 projection oracle [V4,H16,A2]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../../../git/index.js';
import { itemPatchAuthors } from '../../index.js';

/** Attach and remove immutable patch bytes on a real submitted unmerged item, publishing after each mutation. */
export async function seedItemPatches({ board, box, store, exercise, agent, claim, submitFixture }) {
  const item = store.addItem(board, { by: 'coordinator', lane: box.lane,
    title: 'Native companion parity', criterion: 'Exact source-bound patch metadata survives the complete reader oracle.' });
  store.claim(board, item, claim);
  const commit = git(box.root, ['rev-parse', '--verify', 'HEAD']);
  const tree = git(box.root, ['rev-parse', '--verify', `${commit}^{tree}`]);
  // State-only submission enables metadata projection; it is not evidence that a gate or patch composition ran.
  submitFixture(board, item, { agentId: agent, commit, tree });
  const patch = [
    'diff --git a/parity-companion.txt b/parity-companion.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/parity-companion.txt',
    '@@ -0,0 +1 @@',
    '+Native parity companion.',
    '',
  ].join('\n');
  const digest = createHash('sha256').update(patch).digest('hex');
  // The registered coordinator is the actual native author and owns otherwise unassigned paths.
  assert.equal(store.agentById(board, 'coordinator').agent_lane, 'coordinator');
  const attached = await exercise('attachItemPatch', () => store.attachItemPatch(board, item,
    { agentId: 'coordinator', key: 'reader-parity-companion', commit, patch, author: 'coordinator' }));
  assert.equal(attached?.changed, true, 'a refused setup never counts as patch parity');
  const active = store.itemPatches(board, item);
  assert.equal(active.length, 1);
  assert.equal(active[0].commit, commit);
  assert.deepEqual(active[0].source, { commit });
  assert.equal(active[0].patch, patch);
  assert.equal(active[0].digest, digest);
  assert.equal(active[0].author.agentId, 'coordinator');
  const event = store.events(board, { itemId: item }).findLast(entry => entry.event_kind === 'item_patch_attach');
  assert.ok(event, 'attachment has a genuine native event before complete reader comparison');
  const detail = JSON.parse(event.event_detail);
  assert.equal(detail.commit, commit);
  assert.equal(detail.digest, digest);
  assert.deepEqual(detail.author, active[0].author);
  const removed = await exercise('removeItemPatch', () => store.removeItemPatch(board, item,
    { agentId: 'coordinator', key: 'reader-parity-companion' }));
  assert.equal(removed?.changed, true);
  assert.deepEqual(store.itemPatches(board, item), []);
  assert.deepEqual(itemPatchAuthors(board, item), [active[0].author], 'removal retains actual historical author identity');
  assert.ok(store.events(board, { itemId: item }).some(entry => entry.event_kind === 'item_patch_remove'));
  assert.equal(store.getItem(board, item).item_status, 'submitted');
  assert.equal(store.getItem(board, item).item_commit, commit, 'patch lifecycle never rewrites submitted source');
  await seedPatchFollow({ board, box, store, exercise, claim, commit, patch, digest, submitFixture });
}

/** Follow real ancestor-bound bytes from a clean registered private Git worktree, then compare every reader field. */
async function seedPatchFollow({ board, box, store, exercise, claim, commit, patch, digest, submitFixture }) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-parity-follow-'));
  const root = join(directory, 'builder');
  // A real descendant object is private fixture input, like the existing source-advance recipe.
  git(box.root, ['worktree', 'add', '--detach', root, commit]);
  try {
    // Commit the actual fixture's public policy before freezing its real source authority.
    writeFileSync(join(root, 'pullboard.json'), readFileSync(join(box.root, 'pullboard.json')));
    git(root, ['add', '--', 'pullboard.json']);
    const policyTree = git(root, ['write-tree']);
    const moved = git(root, ['commit-tree', policyTree, '-p', commit, '-m', 'fixture: commit parity follow policy']);
    git(root, ['reset', '--hard', moved]);
    const builder = store.register(board, { lane: box.lane, path: root, family: 'Fixture Parity Follow Builder Vendor' });
    const item = store.addItem(board, { by: 'coordinator', lane: box.lane, title: 'Native companion follow parity',
      criterion: 'A genuine claimed companion follows its clean registered builder head through the complete reader oracle.' });
    const frozen = JSON.stringify({ policy: { version: 1, commit: moved, verify: { policy: 'any', family: 'off' } }, rows: [] });
    store.claim(board, item, { ...claim, agentId: builder, head: moved,
      freeze: () => ({ text: frozen, digest: createHash('sha256').update(frozen).digest('hex') }) });
    store.attachItemPatch(board, item, { agentId: 'coordinator', key: 'reader-parity-follow',
      commit, patch, author: 'coordinator' });
    const before = store.itemPatches(board, item)[0];
    const authors = itemPatchAuthors(board, item);
    const owned = store.getItem(board, item);
    const followed = await exercise('followItemPatches', () => store.followItemPatches(board, item, { agentId: builder, commit: moved }));
    assert.equal(followed?.changed, true, 'an actual binding mutation is required for follow parity');
    const after = store.itemPatches(board, item)[0];
    assert.equal(after.commit, moved);
    assert.deepEqual(after.source, { commit: moved });
    assert.equal(after.attachedCommit, commit);
    assert.equal(after.patch, patch);
    assert.equal(after.digest, digest);
    assert.deepEqual(after.author, before.author);
    assert.deepEqual(itemPatchAuthors(board, item), authors);
    const event = store.events(board, { itemId: item }).findLast(entry => entry.event_kind === 'item_patch_follow');
    assert.ok(event, 'follow has a genuine native event and complete reader comparison');
    assert.deepEqual(JSON.parse(event.event_detail).patches, [{ key: before.key, oldHead: commit, newHead: moved, hash: digest }]);
    const retained = store.getItem(board, item);
    assert.equal(retained.item_status, 'claimed');
    assert.equal(retained.item_owner, builder);
    assert.equal(retained.item_lease_until, owned.item_lease_until);
    assert.equal(retained.item_commit, owned.item_commit, 'following companion metadata never submits or rewrites item source');
    assert.equal(git(root, ['rev-parse', 'HEAD']), moved);
    assert.equal(git(root, ['status', '--porcelain']), '');
    // The builder then proposes an automatic companion; the real submit opens its owning lane's objection window,
    // and the owner's objection inside it reopens the item. Synthetic state-only submission, no gate claimed [C7,H16,A2].
    const proposed = store.attachItemPatch(board, item, { agentId: builder, key: 'reader-parity-objection',
      commit: moved, patch: patch.replaceAll('parity-companion', 'parity-objection'), author: 'coordinator', autoAttach: true });
    assert.equal(proposed?.changed, true, 'a refused setup never counts as objection parity');
    const submittedTree = git(root, ['rev-parse', '--verify', `${moved}^{tree}`]);
    submitFixture(board, item, { agentId: builder, commit: moved, tree: submittedTree });
    const opened = store.events(board, { itemId: item }).findLast(entry => entry.event_kind === 'item_patch_window');
    assert.ok(opened, 'submission opened a recorded objection window');
    const objected = await exercise('objectItemPatch', () => store.objectItemPatch(board, item,
      { agentId: 'coordinator', key: 'reader-parity-objection', note: 'Synthetic owner objection for state projection only.' }));
    assert.equal(objected?.reopened, true, 'only a real objection inside its window counts');
    assert.equal(store.getItem(board, item).item_status, 'open');
    assert.ok(store.events(board, { itemId: item }).some(entry => entry.event_kind === 'item_patch_object'));
  } finally {
    try { git(box.root, ['worktree', 'remove', '--force', root]); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}
