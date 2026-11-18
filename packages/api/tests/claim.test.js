/** Native event projections preserve retained claims and the lifecycle's rare routes [N26,C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../../store/index.js';
import { logEvent } from '../../store/index.js';
import { withListFields } from '../../items/index.js';
import { projectItemState } from '../index.js';
import { fixtureBoard } from '../../board/tests/fixtures/board.js';
import { submitFixture } from '../../store/tests/fixtures/submit.js';

const COMMIT = 'a'.repeat(40);

/** Seed the real schema and native claim moves without claiming a fixture gate ran. */
function fixture(t) {
  let now = Date.parse('2026-10-28T00:00:00Z');
  const board = fixtureBoard(t, { clock: { now: () => new Date(now) } });
  store.register(board, { lane: 'coordinator', path: '/list/root' });
  const builder = store.register(board, { lane: 'core', path: '/list/builder', session: 'builder', parent: 'parent' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Projected item', criterion: 'Original promise' });
  /** Freeze the actual criterion so a changed promise produces changed bytes. */
  const freeze = item => ({ text: item.item_criterion, digest: 'digest:' + item.item_criterion });
  /** Make each transition's recorded arrival distinguishable. */
  const advance = () => { now += 1000; };
  /** Claim through the production move using the fixture's explicit frozen bar. */
  const claim = () => store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: 3_600_000, freeze, head: COMMIT });
  /** Read the real serve projection before deriving the list's lifecycle counts. */
  const project = (status) => {
    const row = store.getItem(board, id);
    const item = { ...projectItemState(board, row, new Map([[id, row.item_status]])), thread: [] };
    if (status) item.status = status;
    return withListFields({ items: [item] }, new Map([[id, row.item_lease_until]])).state;
  };
  let submits = 0;
  /** Store a native submit using an explicitly synthetic board-state proof. */
  const submit = () => { const commit = (++submits).toString(16).padStart(40, 'a'); return submitFixture(board, id, { agentId: builder, commit, tree: commit }); };
  return { board, id, builder, freeze, advance, claim, project, submit };
}

test('api.claim.retained-claim-refreeze-stays-claimed: a retained-claim refreeze stays claimed and its following submit remains visible [N26,C7]', t => {
  const f = fixture(t);
  f.claim();
  f.advance();
  store.editItem(f.board, f.id, { agentId: 'coordinator', criterion: 'Corrected promise', reason: 'The original promise omitted a case', freeze: f.freeze });
  const refreeze = store.refreeze(f.board, f.id, { agentId: 'coordinator', freeze: f.freeze });
  assert.equal(refreeze.retainedClaim, true);
  const claimed = f.project();
  assert.equal(claimed.items[0].history.findLast(event => event.kind === 'refreeze').retainedClaim, true);
  assert.equal(claimed.moveCounts['claimed>claimed:refreeze'], 1);
  assert.equal(claimed.moveCounts['claimed>open:refreeze'] ?? 0, 0);
  f.advance();
  f.submit();
  const submitted = f.project();
  assert.equal(submitted.moveCounts['claimed>submitted:submit'], 1);
  assert.equal(submitted.moveCounts['claimed>open:refreeze'] ?? 0, 0);
  assert.equal(submitted.items[0].stage, 'submitted');
  assert.equal(submitted.items[0].since, store.events(f.board, { itemId: f.id }).findLast(event => event.event_kind === 'submit').event_at);
});

test('api.claim.refreeze-without-retained-claim-records: a refreeze without a retained claim records a hand-back before a new claim and submit [N26,C7]', t => {
  const f = fixture(t);
  f.claim();
  f.submit();
  f.advance();
  store.refreeze(f.board, f.id, { agentId: 'coordinator', freeze: () => ({ text: 'Changed bar', digest: 'changed' }) });
  const open = f.project();
  assert.equal(open.items[0].status, 'open');
  assert.equal(Object.hasOwn(open.items[0].history.findLast(event => event.kind === 'refreeze'), 'retainedClaim'), false);
  assert.equal(open.moveCounts['submitted>open:refreeze'], 1);
  f.advance();
  f.claim();
  f.submit();
  assert.equal(f.project().moveCounts['claimed>submitted:submit'], 2);
});

test('api.claim.native-patch-attach-remove-events: native patch attach and remove events both count the declared patch route [N26,C7]', t => {
  const f = fixture(t);
  f.claim();
  f.submit();
  store.attachItemPatch(f.board, f.id, { agentId: 'coordinator', key: 'fix', commit: store.getItem(f.board, f.id).item_commit, author: f.builder,
    patch: 'diff --git a/src/example.js b/src/example.js\n--- a/src/example.js\n+++ b/src/example.js\n@@ -1 +1 @@\n-old\n+new\n' });
  store.removeItemPatch(f.board, f.id, { agentId: 'coordinator', key: 'fix' });
  const state = f.project();
  assert.deepEqual(state.items[0].history.filter(event => event.kind.startsWith('item_patch_')).map(event => event.kind), ['item_patch_attach', 'item_patch_remove']);
  assert.equal(state.moveCounts['submitted>submitted:patch'], 2);
});

test('api.claim.seeded-native-merge-only-receipts: seeded native merge-only receipts count one carry rather than a second ordinary submit [N26,C7]', t => {
  const f = fixture(t);
  f.claim();
  // This seeds projection inputs only; it does not claim to validate a Git merge or a carried verdict.
  logEvent(f.board, f.builder, 'merge-only-accept', f.id, { commit: COMMIT, by: 'reviewer' });
  logEvent(f.board, f.builder, 'submit', f.id, { commit: COMMIT });
  const state = f.project('verified');
  assert.equal(state.moveCounts['claimed>verified:submit-merge'], 1);
  assert.equal(state.moveCounts['claimed>submitted:submit'] ?? 0, 0);
  assert.equal(state.items[0].stage, 'accepted');
});

test('api.claim.claimed-native-patch-attach-remove: claimed native patch attach and remove preserve the following ordinary submit [N26,C7]', t => {
  const f = fixture(t);
  f.claim();
  store.attachItemPatch(f.board, f.id, { agentId: 'coordinator', key: 'claimed', commit: COMMIT, author: f.builder,
    patch: 'diff --git a/src/example.js b/src/example.js\n--- a/src/example.js\n+++ b/src/example.js\n@@ -1 +1 @@\n-old\n+new\n' });
  store.removeItemPatch(f.board, f.id, { agentId: 'coordinator', key: 'claimed' });
  f.submit();
  const state = f.project();
  assert.deepEqual(state.items[0].history.filter(event => event.kind.startsWith('item_patch_')).map(event => event.kind), ['item_patch_attach', 'item_patch_remove']);
  assert.equal(state.moveCounts['claimed>claimed:patch-claimed'], 2);
  assert.equal(state.moveCounts['claimed>submitted:submit'], 1);
  assert.equal(state.items[0].stage, 'submitted');
});

test('api.claim.genuine-accepted-rehome-import-counts: a genuine accepted rehome import counts the recorded rehome_import kind [N26,C7]', t => {
  const f = fixture(t);
  f.claim();
  f.submit();
  const reviewer = store.register(f.board, { lane: 'core', path: '/list/reviewer', session: 'reviewer', parent: 'independent' });
  const source = store.getItem(f.board, f.id);
  store.verify(f.board, f.id, { agentId: reviewer, decision: 'ACCEPT', head: source.item_commit,
    digest: source.item_frozen_digest, policy: 'any', note: 'Synthetic board-state acceptance for projection; no external proof is claimed.' });
  const destination = fixtureBoard(t);
  store.register(destination, { lane: 'coordinator', path: '/list/destination' });
  const moveId = 'lifecycle-accepted-import';
  const destinationItemId = store.reserveRehomeItemId(destination, store.boardId(f.board), moveId, { agentId: 'coordinator' });
  const record = store.rehomeItem(f.board, f.id, { agentId: 'coordinator', sourceMoveId: moveId,
    destinationBoardId: store.boardId(destination), destinationItemId });
  store.applyRehomeItem(destination, record, { destinationAgentId: 'coordinator' });
  const row = store.getItem(destination, destinationItemId);
  const item = { ...projectItemState(destination, row, new Map([[destinationItemId, row.item_status]])), thread: [] };
  const state = withListFields({ items: [item] }, new Map()).state;
  assert.equal(state.items[0].history.at(-1).kind, 'rehome_import', 'the importer itself records the native kind');
  assert.equal(state.moveCounts['open>verified:rehomeImport'], 1);
  assert.equal(state.items[0].stage, 'accepted');
});

test('api.claim.genuine-outside-intake-counts-recorded: a genuine outside intake counts the recorded outside-intake kind as the intake move [N26,C7]', t => {
  const f = fixture(t);
  const text = '{"rows":[]}';
  const outside = store.intakeOutside(f.board, { agentId: 'coordinator',
    source: { kind: 'pull-request', repository: 'fixture/repository', number: 1665, author: 'outside-contributor', state: 'open', maintainerReplied: false,
      commit: 'd'.repeat(40), tree: 'e'.repeat(40), base: 'f'.repeat(40), files: ['outside.txt'], sensitive: false },
    item: { lane: 'core', title: 'Outside lifecycle input', criterion: 'The outside intake is counted', check: 'true', route: 'strong' },
    frozen: { text, digest: createHash('sha256').update(text).digest('hex') } });
  const row = store.getItem(f.board, outside);
  const item = { ...projectItemState(f.board, row, new Map([[outside, row.item_status]])), thread: [] };
  const state = withListFields({ items: [item] }, new Map()).state;
  assert.equal(state.items[0].history.some(event => event.kind === 'outside-intake'), true, 'the board records the outside-intake kind');
  assert.equal(state.moveCounts['open>submitted:intake'], 1, 'one intake move, not an unmatched event');
  assert.equal(state.items[0].stage, 'submitted');
});
