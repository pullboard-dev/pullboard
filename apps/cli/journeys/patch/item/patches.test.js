import { reviewPatchAuthors } from '../../../../../packages/verify/index.js';
import { committedItemAuthors } from '../../../../../packages/verify/index.js';
import { twoTierReviews } from '../../../../../packages/verify/index.js';
/** Source-bound patches retain author independence and exact replay without manufacturing proof [V4,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { composeItemPatches } from '../../../../../packages/items/index.js';
import { normalizeItemPatch } from '../../../../../packages/items/index.js';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { appliedSequence } from '../../../../../packages/state/index.js';
import { applyEngineMove } from '../../../../../packages/state/index.js';
import { applyRelayMove } from '../../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../../packages/state/index.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { importBoard } from '../../../../../packages/store/index.js';
import { parentSessionDigest } from '../../../../../packages/items/index.js';
import { ITEM_PATCH_ENGINE } from '../../../../../packages/state/light.js';
import { PATCH_AUTHOR_IDENTITY_ENGINE } from '../../../../../packages/state/light.js';
import { retainedVerifierIdentityProblem } from '../../../../../packages/items/index.js';
import { itemPatches } from '../../../../../packages/items/index.js';
import { itemPatchAuthors } from '../../../../../packages/items/index.js';
import { itemPatchDigest } from '../../../../../packages/items/index.js';
import { itemPatchReviewProblem } from '../../../../../packages/items/index.js';
import { itemPatchSetDigest } from '../../../../../packages/items/index.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';

const COMMIT = 'a'.repeat(40);
const PATCH = 'diff --git a/src/example.js b/src/example.js\n--- a/src/example.js\n+++ b/src/example.js\n@@ -1 +1 @@\n-old\n+new\n';
/** Build a real native submitted item; its synthetic state receipt is not claimed runtime evidence. */
function fixture(t) {
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/patch-domain' });
  const builder = store.register(board, { lane: 'web', path: '/patch-domain/web', session: 'patch-builder', parent: 'patch-parent' });
  const reviewer = store.register(board, { lane: 'api', path: '/patch-domain/api' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Patch parent' });
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000,
    freeze: () => ({ text: 'Patch criterion', digest: 'patch-frozen' }) });
  submitFixture(board, id, { agentId: builder, commit: COMMIT, tree: 'b'.repeat(40) });
  return { board, id, builder, reviewer };
}
/** Make an explicit coordinator patch request, never a default for missing-author negative controls. */
function input(author, key = 'fix') { return { agentId: 'coordinator', key, commit: COMMIT, patch: PATCH, author }; }

test('patches bind exact bytes, source and native identity; immutable retries retain removed authors [V4,H16]', t => {
  const { board, id, builder } = fixture(t);
  assert.equal(itemPatchDigest(board, id), null);
  assert.equal(itemPatchDigest(board, 999999), null, 'missing items retain native caller refusal ordering');
  assert.equal(itemPatchDigest(board, undefined), null);
  assert.equal(itemPatchDigest(board, '#1'), null);
  const options = input(builder);
  const first = store.attachItemPatch(board, id, options);
  assert.equal(first.changed, true);
  const [record] = itemPatches(board, id);
  assert.deepEqual(record.author, { agentId: builder, parentSession: parentSessionDigest('patch-parent'), session: parentSessionDigest('patch-builder') });
  assert.equal(record.source.commit, COMMIT);
  assert.equal(first.digest, itemPatchSetDigest(COMMIT, [record]));
  assert.equal(itemPatchReviewProblem(board, store.getItem(board, id), first.digest, { getItem: store.getItem }), null);
  assert.equal(itemPatchReviewProblem(board, store.getItem(board, id), undefined, { getItem: store.getItem }).code, 'ITEM_PATCH_CHANGED');
  const before = exportBoard(board);
  assert.equal(store.attachItemPatch(board, id, options).changed, false);
  assert.deepEqual(exportBoard(board), before, 'exact attach retry appends nothing');
  assert.throws(() => store.attachItemPatch(board, id, { ...options, patch: PATCH.replace('+new', '+changed') }), { code: 'ITEM_PATCH_CONFLICT' });
  assert.deepEqual(exportBoard(board), before, 'conflicting immutable retry is atomic');
  const removed = store.removeItemPatch(board, id, { agentId: 'coordinator', key: 'fix' });
  assert.equal(removed.changed, true);
  assert.deepEqual(itemPatches(board, id), []);
  assert.notEqual(itemPatchDigest(board, id), null, 'removed history still participates in review contract');
  assert.deepEqual(itemPatchAuthors(board, id), [record.author]);
  assert.equal(itemPatchReviewProblem(board, store.getItem(board, id), first.digest, { getItem: store.getItem }).code, 'ITEM_PATCH_CHANGED');
  board.executionEngineVersion = ITEM_PATCH_ENGINE - 1;
  assert.equal(itemPatchDigest(board, id), null, 'historical replay does not acquire patch semantics');
  assert.deepEqual(itemPatches(board, id), []);
  assert.deepEqual(itemPatchAuthors(board, id), []);
  delete board.executionEngineVersion;
  const after = exportBoard(board);
  assert.equal(store.removeItemPatch(board, id, { agentId: 'coordinator', key: 'fix' }).changed, false);
  assert.equal(store.attachItemPatch(board, id, options).changed, false, 'old key never silently reactivates');
  assert.deepEqual(exportBoard(board), after);
});

test('patch mutation refuses forged authors, actors, malformed bytes and stale source without effects [V4,H16]', t => {
  const { board, id, builder } = fixture(t);
  for (const options of [
    { ...input(builder), agentId: builder },
    { ...input(builder), author: { agentId: builder, session: 'forged' } },
    { ...input(builder), author: 'missing-seat' },
    { ...input(builder), commit: 'c'.repeat(40) },
    { ...input(builder), patch: 'not a diff' },
    { ...input(builder), patch: PATCH + '\0' },
    { ...input(builder), patch: PATCH + '\ud800' },
    { ...input(builder), patch: PATCH + 'x'.repeat(8 * 1024 * 1024) },
    { ...input(builder), key: '../escape' },
  ]) {
    const before = exportBoard(board);
    assert.throws(() => store.attachItemPatch(board, id, options));
    assert.deepEqual(exportBoard(board), before);
  }
  assert.throws(() => store.removeItemPatch(board, id, { agentId: builder, key: 'fix' }), { code: 'COORDINATOR_ONLY' });
});

test('changed inputs revoke acceptance, preserve the bar and retain a live reviewer [V4,V15,H16]', t => {
  const { board, id, builder, reviewer } = fixture(t);
  store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', head: COMMIT, digest: 'patch-frozen', policy: 'any', note: 'synthetic board-state acceptance; no runtime proof claimed' });
  assert.equal(store.getItem(board, id).item_status, 'verified');
  store.attachItemPatch(board, id, input(builder));
  const changed = store.getItem(board, id);
  assert.equal(changed.item_status, 'submitted');
  assert.equal(changed.item_verdict, null);
  assert.equal(changed.item_verified_by, null);
  assert.equal(changed.item_review_by, null);
  assert.equal(changed.item_review_until, null);
  assert.equal(changed.item_frozen_digest, 'patch-frozen');
  assert.equal(changed.item_commit, COMMIT);
  const reserved = store.reserveReview(board, id, { agentId: reviewer, leaseMs: 60_000, policy: 'any' });
  const previousProof = itemPatchDigest(board, id);
  store.attachItemPatch(board, id, input(builder, 'rebound'));
  assert.equal(store.getItem(board, id).item_review_by, reviewer);
  assert.equal(store.getItem(board, id).item_review_until, reserved.item_review_until);
  assert.throws(() => store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', head: COMMIT,
    digest: 'patch-frozen', policy: 'any', companionDigest: previousProof, note: 'synthetic stale input control' }), { code: 'ITEM_PATCH_CHANGED' });
  store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', head: COMMIT, digest: 'patch-frozen', policy: 'any', note: 'synthetic state control', companionDigest: itemPatchDigest(board, id) });
  store.removeItemPatch(board, id, { agentId: 'coordinator', key: 'fix' });
  assert.equal(store.getItem(board, id).item_status, 'submitted');
  assert.equal(store.getItem(board, id).item_verdict, null);
});

test('native patch moves replay exactly and reject downgrade or foreign actors before mutations [V4,H16]', t => {
  const { board, id, builder } = fixture(t);
  const peer = openBoard(':memory:');
  t.after(() => store.closeBoard(peer));
  importBoard(peer, exportBoard(board));
  const move = prepareEngineMove(board, 'attachItemPatch', [id, input(builder)], { id: 'patch-native' });
  const before = exportBoard(peer);
  assert.throws(() => applyEngineMove(peer, { ...move, engine: ITEM_PATCH_ENGINE - 1 }, { sequence: 1, at: '2026-10-27T00:00:00.000Z' }), { code: 'RELAY_MOVE' });
  assert.equal(appliedSequence(peer), 0);
  assert.deepEqual(exportBoard(peer), before);
  const sender = { kind: 'agent', userId: 'fixture-user', agent: builder };
  const refused = applyRelayMove(peer, { ...move, id: 'foreign-patch' }, { sequence: 1, at: '2026-10-27T00:00:00.000Z', sender, kind: 'move' });
  assert.equal(refused.error.code, 'RELAY_SENDER_MISMATCH');
  assert.deepEqual(itemPatches(peer, id), []);
  const accepted = applyEngineMove(peer, move, { sequence: 2, at: '2026-10-27T00:00:01.000Z' });
  assert.equal(accepted.error, undefined);
  assert.deepEqual(applyEngineMove(peer, move, { sequence: 2, at: '2026-10-27T00:00:01.000Z' }), accepted);
  assert.deepEqual(itemPatchAuthors(peer, id), itemPatches(peer, id).map(record => record.author));
});

/** Retain attachment order and binary bytes; consumers still validate application against source. */
test('active patch ordering and binary bytes are stable review inputs [V4,H16]', t => {
  const { board, id, builder } = fixture(t);
  store.attachItemPatch(board, id, input(builder, 'z-first'));
  const binary = 'diff --git a/asset.bin b/asset.bin\nindex 1234567..7654321 100644\nGIT binary patch\nliteral 1\nIc${Nk000310RR91\n';
  store.attachItemPatch(board, id, { ...input(builder, 'a-second'), patch: binary });
  const patches = itemPatches(board, id);
  assert.deepEqual(patches.map(record => record.key), ['z-first', 'a-second']);
  assert.equal(patches[1].patch, binary);
  assert.notEqual(itemPatchSetDigest(COMMIT, patches), itemPatchSetDigest(COMMIT, [...patches].reverse()));
});

/** Native author provenance remains disqualifying after removal; stale verdict attempts are atomic. */
test('companion authors and related seats cannot review removed history, while unrelated review binds current inputs [V1,V4,H16]', t => {
  const { board, id, reviewer } = fixture(t);
  const author = store.register(board, { lane: 'api', path: '/patch-domain/companion-author', parent: 'companion-parent', session: 'companion-session' });
  const related = store.register(board, { lane: 'api', path: '/patch-domain/companion-related', parent: 'companion-parent', session: 'companion-session' });
  const attached = store.attachItemPatch(board, id, input(author));
  /** Assert both public review entrypoints refuse without changing real board state or history. */
  function refusesReview(agentId, code) {
    const before = exportBoard(board);
    assert.throws(() => store.reserveReview(board, id, { agentId, leaseMs: 60_000, policy: 'any' }), { code });
    assert.deepEqual(exportBoard(board), before);
    assert.throws(() => store.verify(board, id, { agentId, decision: 'ACCEPT', head: COMMIT, digest: 'patch-frozen',
      policy: 'any', companionDigest: itemPatchDigest(board, id), note: 'synthetic board-state identity control; no runtime proof claimed' }), { code });
    assert.deepEqual(exportBoard(board), before);
  }
  refusesReview(author, 'SELF_VERIFY');
  refusesReview(related, 'SELF_SESSION_VERIFY');
  store.removeItemPatch(board, id, { agentId: 'coordinator', key: 'fix' });
  assert.deepEqual(itemPatches(board, id), []);
  assert.ok(itemPatchAuthors(board, id).some(identity => identity.agentId === author));
  refusesReview(author, 'SELF_VERIFY');
  refusesReview(related, 'SELF_SESSION_VERIFY');
  const before = exportBoard(board);
  assert.throws(() => store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', head: COMMIT, digest: 'patch-frozen',
    policy: 'any', companionDigest: attached.digest, note: 'synthetic stale patch-set acceptance attempt' }), { code: 'ITEM_PATCH_CHANGED' });
  assert.deepEqual(exportBoard(board), before, 'stale actual ACCEPT appends no verdict or event and changes no state');
  store.reserveReview(board, id, { agentId: reviewer, leaseMs: 60_000, policy: 'any' });
  store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', head: COMMIT, digest: 'patch-frozen', policy: 'any',
    companionDigest: itemPatchDigest(board, id), note: 'synthetic native board-state acceptance; no runtime execution asserted' });
  assert.equal(store.getItem(board, id).item_status, 'verified', 'unrelated native reviewer can accept the current explicit empty patch set');
});

test('a companion author without session metadata cannot review active or removed inputs [V1,V4,H16]', t => {
  const { board, id, reviewer } = fixture(t);
  const author = store.register(board, { lane: 'api', path: '/patch-domain/no-session-author' });
  store.attachItemPatch(board, id, input(author));
  const identity = itemPatchAuthors(board, id).find(record => record.agentId === author);
  assert.equal(identity.parentSession, null);
  assert.equal(identity.session, null);
  for (const removed of [false, true]) {
    if (removed) store.removeItemPatch(board, id, { agentId: 'coordinator', key: 'fix' });
    const before = exportBoard(board);
    assert.throws(() => store.reserveReview(board, id, { agentId: author, leaseMs: 60_000, policy: 'any' }), { code: 'SELF_VERIFY' });
    assert.throws(() => store.verify(board, id, { agentId: author, decision: 'ACCEPT', head: COMMIT,
      digest: 'patch-frozen', policy: 'any', companionDigest: itemPatchDigest(board, id),
      note: 'Synthetic native author control; no runtime proof claimed.' }), { code: 'SELF_VERIFY' });
    assert.equal(retainedVerifierIdentityProblem(board, store.getItem(board, id), author, { reviewPatchAuthors, committedItemAuthors, twoTierReviews }).code, 'SELF_VERIFY');
    assert.deepEqual(exportBoard(board), before, 'direct-author refusals preserve the item and history');
  }
  store.reserveReview(board, id, { agentId: reviewer, leaseMs: 60_000, policy: 'any' });
  store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', head: COMMIT, digest: 'patch-frozen',
    policy: 'any', companionDigest: itemPatchDigest(board, id), note: 'Synthetic unrelated reviewer positive control.' });
  assert.equal(store.getItem(board, id).item_status, 'verified');
});

test('ordered direct-companion author refusals retain their historical code and new explicit identity rule [V1,H16]', t => {
  const { board: seed, id } = fixture(t);
  const author = store.register(seed, { lane: 'api', path: '/patch-domain/ordered-author',
    parent: 'ordered-companion-parent', session: 'ordered-companion-session' });
  store.attachItemPatch(seed, id, input(author));
  store.removeItemPatch(seed, id, { agentId: 'coordinator', key: 'fix' });
  const move = prepareEngineMove(seed, 'reserveReview', [id, { agentId: author, leaseMs: 60_000, policy: 'any' }], { id: 'direct-patch-author-review' });
  assert.ok(move.engine >= PATCH_AUTHOR_IDENTITY_ENGINE);
  for (const engine of [PATCH_AUTHOR_IDENTITY_ENGINE - 1, PATCH_AUTHOR_IDENTITY_ENGINE]) {
    const replica = openBoard(':memory:');
    t.after(() => store.closeBoard(replica));
    importBoard(replica, exportBoard(seed));
    const before = store.getItem(replica, id);
    const order = { sequence: 1, at: new Date().toISOString() };
    const outcome = applyEngineMove(replica, { ...move, engine }, order);
    assert.equal(outcome.error?.code, engine < PATCH_AUTHOR_IDENTITY_ENGINE ? 'SELF_SESSION_VERIFY' : 'SELF_VERIFY');
    assert.deepEqual(store.getItem(replica, id), before, 'the refusal never reserves or changes the submitted item');
    assert.deepEqual(applyEngineMove(replica, { ...move, engine }, order), outcome, 'a retry returns the recorded refusal');
  }
});

/** Exercise intake through a private real CLI and inspect its persisted native patch records. */
async function intakeFixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  /** Require command success before decoding its actual JSON response. */
  const run = async (cwd, ...args) => {
    const result = await box.runLocal(cwd, ...args, '--json');
    assert.equal(result.code, 0, result.err + result.out);
    return JSON.parse(result.out);
  };
  const item = (await fixtureAdd(run, box.repo, 'web', 'Patch intake case', '--specs', 'G1')).item.item_id;
  const author = (await run(box.web, 'whoami')).id;
  await run(box.web, 'claim', String(item));
  const source = box.git(box.web, 'rev-parse', 'HEAD');
  // @pullboard-board-file journey: real CLI intake and native composition share this private durable board.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  t.after(() => store.closeBoard(board));
  return { ...box, run, board, item, author, source };
}

test('patch attach accepts real format-patch headers and trailer without changing hunk bytes [V4,H16]', async t => {
  const box = await intakeFixture(t);
  const { run } = box;
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/mail.txt'), 'mail body\n-- \n2.50.0\n');
  box.git(box.web, 'add', 'web/mail.txt');
  box.git(box.web, 'commit', '-m', 'feat(web): real mail input [G1]');
  const mail = box.git(box.web, 'format-patch', '-1', '--stdout') + '\n';
  assert.match(mail, /^From [a-f0-9]+ Mon Sep 17/u);
  const expected = box.git(box.web, 'show', '--format=', '--binary', 'HEAD') + '\n';
  submitFixture(box.board, box.item, { agentId: box.author, commit: box.source,
    tree: box.git(box.web, 'rev-parse', box.source + '^{tree}') });
  const file = join(box.dir, 'mail.patch');
  writeFileSync(file, mail);
  const attached = await run(box.repo, 'patch', 'attach', String(box.item), file, '--key', 'mail', '--author', box.author, '--source', box.source);
  assert.equal(attached.changed, true);
  const [record] = itemPatches(box.board, box.item);
  assert.equal(record.patch, expected);
  assert.equal(record.author.agentId, box.author, 'mail From never grants a native author identity');
  assert.equal(record.commit, box.source);
  const composed = composeItemPatches(box.repo, { item_commit: box.source }, [record]);
  assert.equal(box.git(box.repo, 'show', composed.commit + ':web/mail.txt'), 'mail body\n-- \n2.50.0');
  const retry = await run(box.repo, 'patch', 'attach', String(box.item), file, '--key', 'mail', '--author', box.author, '--source', box.source);
  assert.equal(retry.changed, false);
  assert.throws(() => normalizeItemPatch(mail.replace('Subject:', 'Not-Subject:')), { code: 'ITEM_PATCH_FORMAT' });
  assert.throws(() => normalizeItemPatch(mail.replace('@@ -0,0 +1,3 @@', '@@ -0,0 +1,4 @@')), { code: 'ITEM_PATCH_FORMAT' });
});

test('mixed-lane attach reports three owners and writes only unconfirmed per-lane drafts [V4,H16]', async t => {
  const box = await intakeFixture(t), api = join(box.dir, 'api-owner');
  const { run } = box;
  box.git(box.repo, 'worktree', 'add', '--detach', api, 'main');
  await fixtureJoin(box.runLocal, api, 'api');
  const apiOwner = (await run(api, 'whoami')).id;
  submitFixture(box.board, box.item, { agentId: box.author, commit: box.source,
    tree: box.git(box.web, 'rev-parse', box.source + '^{tree}') });
  const changes = ['web/mail.txt', 'api/mail.txt', 'owner.txt'].map(path =>
    `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+value\n`);
  const file = join(box.dir, 'mixed.patch'), directory = join(box.dir, 'parts');
  writeFileSync(file, changes.join(''));
  const before = exportBoard(box.board);
  const result = await run(box.repo, 'patch', 'attach', String(box.item), file, '--key', 'mixed', '--author', box.author, '--source', box.source, '--out', directory);
  assert.equal(result.attached, false);
  assert.equal(result.needsConfirmation, true);
  assert.deepEqual(result.parts.map(part => part.lane), ['web', 'api', 'coordinator']);
  assert.deepEqual(result.parts.map(part => part.owners), [[box.author], [apiOwner], ['coordinator']]);
  for (const [n, part] of result.parts.entries()) {
    assert.equal(part.patch, changes[n]);
    assert.equal(readFileSync(part.file, 'utf8'), changes[n]);
    assert.equal(box.tryGit(box.repo, 'apply', '--check', part.file).status, 0, 'each exact owner draft applies to the source');
  }
  assert.deepEqual(itemPatches(box.board, box.item), []);
  assert.deepEqual(exportBoard(box.board), before, 'draft planning never attaches, confirms or mutates the board');
  const text = await run(box.repo, 'patch', 'attach', String(box.item), file, '--key', 'mixed', '--author', box.author, '--source', box.source);
  assert.equal(text.needsConfirmation, true);
  const collision = await box.runLocal(box.repo, 'patch', 'attach', String(box.item), file, '--key', 'mixed', '--author', box.author, '--source', box.source, '--out', directory, '--json');
  assert.equal(collision.code, 1);
  assert.equal(JSON.parse(collision.out).error.code, 'ITEM_PATCH_OUTPUT');
  assert.equal(readFileSync(result.parts[0].file, 'utf8'), changes[0]);
});
