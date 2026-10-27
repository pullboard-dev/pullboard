/** Real native companion mutations pass the complete HTTP/pinned API2 projection oracle [V4,H16,A2]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { git } from '../src/git.js';
import { itemPatchAuthors } from '../src/item-patch-state.js';

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
}
