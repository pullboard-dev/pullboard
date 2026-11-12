/** Real companions follow clean builder movement without changing bytes, author custody or replay [C7,H16]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { itemPatchRecords } from '../../../../packages/items/index.js';
import { itemPatchAuthors } from '../../../../packages/items/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { PATCH_FOLLOW_ENGINE } from '../../../../packages/state/light.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

/** Require the real CLI result, preserving setup refusal diagnostics. */
function document(result) {
  assert.equal(result.code, 0, result.err + '\n' + result.out);
  return JSON.parse(result.out);
}

/** Run a private fixture command under its normal joined session. */
function run(f, actor, ...args) {
  const before = f.box.env.CODEX_THREAD_ID;
  f.box.env.CODEX_THREAD_ID = actor.session;
  try { return f.box.run(actor.root, ...args, ...(['submit', 'release'].includes(args[0]) ? ['--no-next'] : []), '--json'); }
  finally { if (before === undefined) delete f.box.env.CODEX_THREAD_ID; else f.box.env.CODEX_THREAD_ID = before; }
}

/** Preserve the private actor's real installed-hook identity for Git writes. */
function actorGit(f, actor, ...args) {
  const before = f.box.env.CODEX_THREAD_ID;
  f.box.env.CODEX_THREAD_ID = actor.session;
  try { return f.box.git(actor.root, ...args); }
  finally { if (before === undefined) delete f.box.env.CODEX_THREAD_ID; else f.box.env.CODEX_THREAD_ID = before; }
}

const STRONG_MODEL = 'strong fixture';

/** Create a genuine joined worktree; no live seat or host identity is borrowed. */
function seat(f, name, lane) {
  const root = join(f.box.dir, name);
  f.box.git(f.box.repo, 'worktree', 'add', '--detach', root, 'main');
  const actor = { root, session: name };
  actor.id = document(run(f, actor, 'join', lane, '--model', STRONG_MODEL)).agent;
  return actor;
}

/** Declare a real source check requiring the off-lane companion and attach its unchanged bytes. */
function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.lanes.core = { owns: ['core/'], specs: ['G1'] };
  config.lanes.view = { owns: ['view/'], specs: ['G2'] };
  // The board's model table determines seat routes since b95e1aa538.
  config.modelTiers = [{ contains: STRONG_MODEL, route: 'strong' }];
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-m', 'chore: private companion policy [G1]');
  const f = { box, coordinator: { root: box.repo, session: box.env.CODEX_THREAD_ID } };
  f.builder = seat(f, 'follow-builder', 'core');
  f.author = seat(f, 'follow-author', 'view');
  f.id = document(run(f, f.coordinator, 'add', 'core', 'Follow the approved view module', '--specs', 'G1',
    '--criterion', 'The actual core command imports the approved view module.', '--check', 'node core/cli.cjs', '--route', 'strong')).item.item_id;
  document(run(f, f.builder, 'claim', String(f.id)));
  mkdirSync(join(f.builder.root, 'core'));
  writeFileSync(join(f.builder.root, 'core/cli.cjs'), "const assert = require('node:assert/strict');\nassert.equal(require('../view/header.cjs'), 'approved view');\nconsole.log('TAP version 13\\nok 1 - actual companion import\\n1..1');\n");
  box.git(f.builder.root, 'add', 'core/cli.cjs');
  actorGit(f, f.builder, 'commit', '-m', 'feat(core): require approved view [G1]');
  f.source = box.git(f.builder.root, 'rev-parse', 'HEAD');
  f.patchFile = join(box.dir, 'view.patch');
  writeFileSync(f.patchFile, "diff --git a/view/header.cjs b/view/header.cjs\nnew file mode 100644\n--- /dev/null\n+++ b/view/header.cjs\n@@ -0,0 +1 @@\n+module.exports = 'approved view';\n");
  // @pullboard-board-file journey: inspect the actual native attachment, follow and Submit events
  f.board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  t.after(() => store.closeBoard(f.board));
  document(run(f, f.coordinator, 'patch', 'attach', String(f.id), f.patchFile,
    '--key', 'approved-view', '--author', f.author.id, '--source', f.source));
  return f;
}

/** Commit a genuine independent main change, then merge it through the builder's normal hooks. */
function mergeMain(f, path = 'docs/new-main.txt', bytes = 'new main\n') {
  mkdirSync(join(f.box.repo, path.split('/')[0]), { recursive: true });
  writeFileSync(join(f.box.repo, path), bytes);
  f.box.git(f.box.repo, 'add', path);
  actorGit(f, f.coordinator, 'commit', '-m', 'chore: advance private main [G1]');
  actorGit(f, f.builder, 'merge', '--no-edit', 'main');
  return f.box.git(f.builder.root, 'rev-parse', 'HEAD');
}

/** Read only this item's recorded binding changes. */
function follows(f) { return store.events(f.board).filter(event => event.item_id === f.id && event.event_kind === 'item_patch_follow'); }

test('a companion follows a clean main merge and real Submit without any coordinator rebind [C7,H16]', t => {
  const f = fixture(t);
  const before = store.itemPatches(f.board, f.id)[0];
  const authors = itemPatchAuthors(f.board, f.id);
  const moved = mergeMain(f);
  const index = f.box.git(f.builder.root, 'write-tree');
  const result = document(run(f, f.builder, 'submit', String(f.id)));
  assert.equal(store.getItem(f.board, f.id).item_status, 'submitted');
  assert.equal(store.getItem(f.board, f.id).item_commit, moved);
  const after = store.itemPatches(f.board, f.id)[0];
  assert.equal(after.commit, moved);
  assert.equal(after.source.commit, moved);
  assert.equal(after.attachedCommit, f.source);
  assert.equal(after.patch, before.patch);
  assert.equal(after.digest, before.digest);
  assert.deepEqual(after.author, before.author);
  assert.deepEqual(itemPatchAuthors(f.board, f.id), authors);
  assert.equal(follows(f).length, 1);
  assert.deepEqual(JSON.parse(follows(f)[0].event_detail).patches,
    [{ key: before.key, oldHead: f.source, newHead: moved, hash: before.digest }]);
  assert.notEqual(result.gate.companion.commit, moved);
  const receipts = store.proofReceipts(f.board, f.id);
  assert.ok(receipts.length > 0);
  assert.ok(receipts.every(receipt => receipt.commit === result.gate.companion.commit && receipt.exitCode === 0));
  assert.equal(f.box.git(f.builder.root, 'rev-parse', 'HEAD'), moved);
  assert.equal(f.box.git(f.builder.root, 'write-tree'), index);
  assert.equal(existsSync(join(f.builder.root, 'view/header.cjs')), false);
  assert.equal(f.box.git(f.builder.root, 'status', '--porcelain'), '');
  const retry = document(run(f, f.coordinator, 'patch', 'attach', String(f.id), f.patchFile,
    '--key', 'approved-view', '--author', f.author.id, '--source', f.source));
  assert.equal(retry.changed, false, 'an original exact attachment retry remains immutable after a follow');
  assert.equal(store.getItem(f.board, f.id).item_status, 'submitted');
  assert.equal(follows(f).length, 1);
});

test('a conflicting companion names its key file and hunk and no member of the set follows [C7,H16]', t => {
  const f = fixture(t);
  const file = join(f.box.dir, 'blocked.patch');
  writeFileSync(file, 'diff --git a/view/blocked.cjs b/view/blocked.cjs\nnew file mode 100644\n--- /dev/null\n+++ b/view/blocked.cjs\n@@ -0,0 +1 @@\n+module.exports = "private patch contents";\n');
  document(run(f, f.coordinator, 'patch', 'attach', String(f.id), file,
    '--key', 'blocked-view', '--author', f.author.id, '--source', f.source));
  const before = itemPatchRecords(f.board, f.id);
  const moved = mergeMain(f, 'view/blocked.cjs', 'module.exports = "different private contents";\n');
  const result = run(f, f.builder, 'submit', String(f.id));
  assert.equal(result.code, 1);
  const error = JSON.parse(result.out).error;
  assert.equal(error.code, 'ITEM_PATCH');
  assert.match(error.message, /blocked-view.*view\/blocked\.cjs.*@@ -0,0 \+1 @@/u);
  assert.doesNotMatch(error.message, /private patch contents|different private contents/u);
  assert.deepEqual(itemPatchRecords(f.board, f.id), before);
  assert.equal(follows(f).length, 0);
  assert.equal(store.proofReceipts(f.board, f.id).length, 0);
  assert.equal(store.getItem(f.board, f.id).item_status, 'claimed');
  assert.equal(f.box.git(f.builder.root, 'rev-parse', 'HEAD'), moved);
  assert.equal(f.box.git(f.builder.root, 'status', '--porcelain'), '');
});

test('a sealed follow replays without origin Git and duplicate delivery records exactly one event [C7,H16]', t => {
  const f = fixture(t);
  const moved = mergeMain(f);
  const replica = openBoard(':memory:');
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(f.board));
  const move = prepareEngineMove(f.board, 'followItemPatches', [f.id, { agentId: f.builder.id, commit: moved }], { id: 'follow-replay' });
  assert.ok(move.engine >= PATCH_FOLLOW_ENGINE);
  assert.throws(() => applyEngineMove(replica, { ...move, engine: PATCH_FOLLOW_ENGINE - 1 },
    { sequence: 1, at: f.board.clock.now().toISOString() }), { code: 'RELAY_MOVE' });
  const result = applyEngineMove(replica, move, { sequence: 1, at: f.board.clock.now().toISOString() });
  assert.equal(result.error, undefined);
  assert.equal(store.itemPatches(replica, f.id)[0].commit, moved);
  assert.equal(store.getItem(replica, f.id).item_owner, f.builder.id);
  assert.equal(store.getItem(replica, f.id).item_status, 'claimed');
  assert.deepEqual(applyEngineMove(replica, move, { sequence: 1, at: f.board.clock.now().toISOString() }), result);
  assert.equal(store.events(replica).filter(event => event.event_kind === 'item_patch_follow').length, 1);
  assert.equal(store.itemPatches(f.board, f.id)[0].commit, f.source, 'preparation alone never writes a binding');
  const olderRemoval = { version: 1, engine: PATCH_FOLLOW_ENGINE - 1, id: 'older-follow-removal',
    operation: 'removeItemPatch', args: [f.id, { agentId: 'coordinator', key: 'approved-view', presubmit: true }] };
  assert.throws(() => applyEngineMove(replica, olderRemoval, { sequence: 2, at: f.board.clock.now().toISOString() }), { code: 'RELAY_MOVE' });
  assert.equal(store.itemPatches(replica, f.id)[0].commit, moved, 'older writers cannot reinterpret a followed binding');
});

test('a companion author cannot follow the builder and tampered set metadata refuses atomically [C7,H16]', t => {
  const f = fixture(t);
  const moved = mergeMain(f);
  const before = itemPatchRecords(f.board, f.id);
  assert.throws(() => prepareEngineMove(f.board, 'followItemPatches', [f.id, { agentId: f.author.id, commit: moved }]), { code: 'NOT_YOURS' });
  assert.throws(() => prepareEngineMove(f.board, 'followItemPatches', [f.id, { agentId: f.builder.id, commit: f.source }]), { code: 'ITEM_PATCH_SOURCE' });
  const move = prepareEngineMove(f.board, 'followItemPatches', [f.id, { agentId: f.builder.id, commit: moved }], { id: 'follow-tampered' });
  const replica = openBoard(':memory:');
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(f.board));
  const forged = structuredClone(move);
  forged.args[1].previous[0].digest = '0'.repeat(64);
  const result = applyEngineMove(replica, forged, { sequence: 1, at: f.board.clock.now().toISOString() });
  assert.equal(result.error.code, 'ITEM_PATCH_CHANGED');
  assert.deepEqual(itemPatchRecords(replica, f.id), before);
  assert.equal(store.events(replica).filter(event => event.event_kind === 'item_patch_follow').length, 0);
});

test('an ordinary builder commit follows only active companions and preserves removed author history [C7,H16]', t => {
  const f = fixture(t);
  const removedFile = join(f.box.dir, 'removed.patch');
  writeFileSync(removedFile, 'diff --git a/view/removed.cjs b/view/removed.cjs\nnew file mode 100644\n--- /dev/null\n+++ b/view/removed.cjs\n@@ -0,0 +1 @@\n+module.exports = 2;\n');
  document(run(f, f.coordinator, 'patch', 'attach', String(f.id), removedFile,
    '--key', 'removed-view', '--author', f.author.id, '--source', f.source));
  document(run(f, f.coordinator, 'patch', 'remove', String(f.id), 'removed-view'));
  const removed = itemPatchRecords(f.board, f.id).find(record => record.key === 'removed-view');
  writeFileSync(join(f.builder.root, 'core/second.cjs'), 'module.exports = 2;\n');
  f.box.git(f.builder.root, 'add', 'core/second.cjs');
  actorGit(f, f.builder, 'commit', '-m', 'feat(core): advance own private source [G1]');
  const moved = f.box.git(f.builder.root, 'rev-parse', 'HEAD');
  const result = document(run(f, f.builder, 'submit', String(f.id)));
  assert.equal(result.commit, moved);
  assert.equal(store.itemPatches(f.board, f.id)[0].commit, moved);
  assert.equal(store.itemPatches(f.board, f.id).length, 1);
  assert.deepEqual(itemPatchRecords(f.board, f.id).find(record => record.key === 'removed-view'), removed);
  assert.deepEqual(itemPatchAuthors(f.board, f.id), [removed.author]);
  assert.equal(follows(f).length, 1);
  assert.equal(JSON.parse(follows(f)[0].event_detail).patches.length, 1);
});
