/** Claimed companions are real source inputs, never permission for a builder's off-lane edits [C7,V4,H16]. */
import { executionServicesSource } from '../../../tests/fixtures/gate/execution.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { prepareItemPatchReview } from '../../../../../packages/items/index.js';
import { effectiveItemHead } from '../../../../../packages/verify/index.js';
import { itemPolicy } from '../../../../../packages/sandbox/index.js';
import { requireTrunkMerge } from '../../../../../packages/sandbox/index.js';
import { retryReviewCommit } from '../../../../../packages/verify/index.js';
import { itemPatchAuthors } from '../../../../../packages/items/index.js';
import { prepareItemPatchSubmit } from '../../../../../packages/items/index.js';
import { sealItemPatchSubmit } from '../../../../../packages/items/index.js';
import { prepareEngineMove } from '../../../../../packages/state/index.js';
import { applyEngineMove } from '../../../../../packages/state/index.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { importBoard } from '../../../../../packages/store/index.js';
import { ITEM_PATCH_ENGINE } from '../../../../../packages/state/light.js';
import { ITEM_PATCH_SUBMIT_ENGINE } from '../../../../../packages/state/light.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';

/** Require the real CLI document, retaining exact diagnostics for every fixture setup refusal. */
function document(result) {
  assert.equal(result.code, 0, result.err + '\n' + result.out);
  return JSON.parse(result.out);
}

/** Make independent private lane seats without changing the source under test. */
function seat(box, name, lane) {
  const root = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '--detach', root, 'main');
  const previous = box.env.CODEX_THREAD_ID;
  box.env.CODEX_THREAD_ID = name;
  let id;
  try { id = document(fixtureJoin(box.run, root, lane, '--json')).agent; }
  finally { if (previous === undefined) delete box.env.CODEX_THREAD_ID; else box.env.CODEX_THREAD_ID = previous; }
  return { root, id, session: name };
}

/** Run through the normal session binding, restoring the fixture environment after each command. */
async function run(box, actor, ...args) {
  const before = box.env.CODEX_THREAD_ID;
  box.env.CODEX_THREAD_ID = actor.session;
  try { return await box.runLocal(actor.root, ...args, ...(['submit', 'verify', 'release', 'next'].includes(args[0]) ? ['--no-next'] : []), '--json'); }
  finally { if (before === undefined) delete box.env.CODEX_THREAD_ID; else box.env.CODEX_THREAD_ID = before; }
}

/** Preserve the same authenticated fixture identity while installed Git hooks call the native CLI. */
function actorGit(box, actor, ...args) {
  const previous = box.env.CODEX_THREAD_ID;
  box.env.CODEX_THREAD_ID = actor.session;
  try { return box.git(actor.root, ...args); }
  finally { if (previous === undefined) delete box.env.CODEX_THREAD_ID; else box.env.CODEX_THREAD_ID = previous; }
}

/** Build real Git and persistent SQLite state with a core command requiring its view companion. */
async function fixture(t, { hold = false, deferred = false, check = 'node core/cli.cjs' } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  if (deferred) config.submitGate = 'landing';
  config.lanes.core = { owns: ['core/'], specs: ['G1'] };
  config.lanes.view = { owns: ['view/'], specs: ['G2'] };
  // Seat routes come from the board's model table since b95e1aa538.
  config.modelTiers = [{ contains: box.env.PULLBOARD_MODEL, route: 'strong' }];
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-m', 'chore: private companion lane policy');
  const coordinator = { root: box.repo, session: box.env.CODEX_THREAD_ID };
  const builder = seat(box, 'presubmit-builder', 'core');
  const author = seat(box, 'presubmit-author', 'view');
  const id = document(await run(box, coordinator, 'add', 'core', 'Core command needs its view import',
    '--specs', 'G1', '--criterion', 'The real core command imports the approved view module.',
    '--check', check)).item.item_id;
  document(await run(box, builder, 'claim', String(id)));
  mkdirSync(join(builder.root, 'core'));
  const entered = join(box.dir, 'entered'), release = join(box.dir, 'release');
  const pause = hold ? `const fs = require('node:fs');fs.writeFileSync(${JSON.stringify(entered)}, 'entered');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);\n` : '';
  writeFileSync(join(builder.root, 'core/cli.cjs'), pause + "const assert = require('node:assert/strict');\nassert.equal(require('../view/header.cjs'), 'approved view');\nconsole.log('TAP version 13\\nok 1 - actual approved view import\\n1..1');\n");
  box.git(builder.root, 'add', 'core/cli.cjs');
  actorGit(box, builder, 'commit', '-m', 'feat(core): use the companion view [G1]');
  const source = box.git(builder.root, 'rev-parse', 'HEAD');
  const patch = [
    'diff --git a/view/header.cjs b/view/header.cjs', 'new file mode 100644',
    '--- /dev/null', '+++ b/view/header.cjs', '@@ -0,0 +1 @@', "+module.exports = 'approved view';", '',
  ].join('\n');
  const patchFile = join(box.dir, 'view.patch');
  writeFileSync(patchFile, patch);
  // @pullboard-board-file journey: inspect actual CLI attachment, proof and submit events on the persistent fixture board
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  return { box, board, coordinator, builder, author, id, source, patch, patchFile, helpers, entered, release };
}

/** Attach the lane author's exact immutable bytes through the real coordinator CLI. */
async function attach(f, key = 'approved-view', source = f.source, file = f.patchFile, author = f.author.id) {
  return document(await run(f.box, f.coordinator, 'patch', 'attach', String(f.id), file,
    '--key', key, '--author', author, '--source', source));
}

/** Produce a second genuine phase pair on the same private item, retaining native admission and receipt writing. */
async function repeatNativePhases(f, binding) {
  const gate = new URL('../../../../../packages/gate/index.js', import.meta.url).href;
  const script = join(f.box.dir, 'repeat-phases.mjs');
  // The store front door replaced src/board.js in #1776.
  writeFileSync(script, `import * as store from ${JSON.stringify(new URL('../../../../../packages/store/index.js', import.meta.url).href)};
import { openBoard } from ${JSON.stringify(new URL("../../../../lib/src/logic/native.js", import.meta.url).href)};
import { runSubmitGate, submitGateConfig } from ${JSON.stringify(gate)};
${executionServicesSource(gate)}
import { withItemPatchSubmit } from ${JSON.stringify(new URL('../../../../../packages/items/index.js', import.meta.url).href)};
import { policyAt, frozenCheck, mainPolicy } from ${JSON.stringify(new URL('../../../../../packages/sandbox/index.js', import.meta.url).href)};
const root = process.cwd();
// @pullboard-board-file journey: record actual native proof receipts on the same persistent CLI fixture board
const board = openBoard(${JSON.stringify(join(f.box.repo, '.git/pullboard/board.sqlite'))});
try {
  const item = store.getItem(board, ${f.id});
  const main = mainPolicy(root);
  const config = submitGateConfig(policyAt(root, ${JSON.stringify(binding.commit)}).config, main.config);
  const gate = await withItemPatchSubmit(root, ${JSON.stringify(binding)}, checkout => runSubmitGate(checkout, config,
    { executionServices, base: item.item_claim_head, trunk: main.commit, check: frozenCheck(item), agent: ${JSON.stringify(f.builder.id)}, item: item.item_id,
      proofContext: { companion: true, item: item.item_id, frozenDigest: item.item_frozen_digest, seat: ${JSON.stringify(f.builder.id)} } }));
  if (!gate.isGreen) throw new Error(gate.output);
  for (const id of gate.proofReceiptIds) store.recordProofRun(board, { agentId: ${JSON.stringify(f.builder.id)}, itemId: item.item_id, receiptId: id });
  console.log(JSON.stringify(gate.proofReceiptIds));
} finally { store.closeBoard(board); }
`);
  const before = f.box.env.CODEX_THREAD_ID;
  f.box.env.CODEX_THREAD_ID = f.builder.session;
  let child;
  try { child = f.helpers.launch(f.box, f.builder.root, process.execPath, [script]); }
  finally { if (before === undefined) delete f.box.env.CODEX_THREAD_ID; else f.box.env.CODEX_THREAD_ID = before; }
  const result = await child.closed;
  assert.equal(result.code, 0, child.stdoutText + child.stderrText);
  return JSON.parse(child.stdoutText.trim().split('\n').at(-1));
}

test('claimed companion submits the real core command and records exact composed native proof [C7,V4,H16]', async t => {
  const f = await fixture(t);
  await attach(f);
  const claimed = store.getItem(f.board, f.id);
  assert.equal(claimed.item_status, 'claimed');
  assert.equal(claimed.item_owner, f.builder.id);
  const beforeHead = f.box.git(f.builder.root, 'rev-parse', 'HEAD');
  const beforeIndex = f.box.git(f.builder.root, 'write-tree');
  const submitted = document(await run(f.box, f.builder, 'submit', String(f.id)));
  assert.equal(store.getItem(f.board, f.id).item_status, 'submitted');
  assert.equal(store.getItem(f.board, f.id).item_commit, f.source);
  const event = store.events(f.board).filter(row => row.event_kind === 'submit' && row.item_id === f.id).at(-1);
  const detail = JSON.parse(event.event_detail);
  const binding = detail.companion;
  assert.equal(binding.source, f.source);
  assert.notEqual(binding.commit, f.source);
  assert.equal(binding.sourceTree, f.box.git(f.builder.root, 'rev-parse', `${f.source}^{tree}`));
  assert.equal(binding.tree, f.box.git(f.builder.root, 'rev-parse', `${binding.commit}^{tree}`));
  assert.equal(prepareItemPatchReview(f.builder.root, f.board, store.getItem(f.board, f.id),
    { effectiveItemHead, itemPolicy, requireTrunkMerge, retryReviewCommit, getItem: store.getItem }).commit, binding.commit,
    'submit and verifier share the actual deterministic composition');
  assert.deepEqual(binding.phases.map(phase => phase.role), ['criterion', 'proof']);
  const options = { ...detail, agentId: f.builder.id };
  assert.equal(sealItemPatchSubmit(f.board, f.id, options), options);
  for (const index of [0, 1]) {
    const incomplete = { ...binding, receiptIds: [binding.receiptIds[index]], phases: [binding.phases[index]] };
    assert.throws(() => sealItemPatchSubmit(f.board, f.id, { ...options, companion: incomplete }), { code: 'ITEM_PATCH_CHANGED' });
  }
  const repeated = await repeatNativePhases(f, binding);
  const substitute = { ...binding, receiptIds: [binding.receiptIds[0], repeated[0]] };
  assert.notEqual(substitute.receiptIds[0], substitute.receiptIds[1]);
  for (const id of substitute.receiptIds) assert.equal(store.proofReceipts(f.board, f.id).find(row => row.id === id).submitPhase, 'criterion');
  assert.throws(() => sealItemPatchSubmit(f.board, f.id, { ...options, companion: substitute }), { code: 'ITEM_PATCH_CHANGED' });
  for (const id of binding.receiptIds) {
    const receipt = store.proofReceipts(f.board, f.id).find(row => row.id === id);
    assert.equal(receipt.commit, binding.commit);
    assert.equal(receipt.tree, binding.tree);
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.sourceClean, true);
  }
  assert.equal(submitted.gate.companion.commit, binding.commit);
  assert.equal(f.box.git(f.builder.root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(f.box.git(f.builder.root, 'write-tree'), beforeIndex);
  assert.equal(existsSync(join(f.builder.root, 'view/header.cjs')), false);
  assert.equal(f.box.git(f.builder.root, 'status', '--porcelain'), '');
  assert.equal(f.box.git(f.builder.root, 'worktree', 'list', '--porcelain').includes('pullboard-companion-submit-'), false);
});

test('an ordinary builder commit follows its unchanged companion without coordinator rebinding [C7,V4]', async t => {
  const f = await fixture(t);
  await attach(f);
  writeFileSync(join(f.builder.root, 'core/second.cjs'), 'module.exports = 2;\n');
  f.box.git(f.builder.root, 'add', 'core/second.cjs');
  actorGit(f.box, f.builder, 'commit', '-m', 'feat(core): advance real builder head [G1]');
  const moved = f.box.git(f.builder.root, 'rev-parse', 'HEAD');
  document(await run(f.box, f.builder, 'submit', String(f.id)));
  assert.equal(store.getItem(f.board, f.id).item_status, 'submitted');
  assert.ok(store.proofReceipts(f.board, f.id).length > 0, 'the followed composition actually executes');
  assert.equal(store.itemPatches(f.board, f.id)[0].key, 'approved-view');
  assert.equal(store.events(f.board).filter(event => event.item_id === f.id && event.event_kind === 'item_patch_follow').length, 1);
  assert.equal(prepareItemPatchSubmit(f.builder.root, f.board, store.getItem(f.board, f.id), moved).source, moved);
  assert.equal(itemPatchAuthors(f.board, f.id).length, 1, 'following never removes original author custody');
});

test('a nonapplying claimed companion refuses by key without mutating builder source [C7,V4]', async t => {
  const f = await fixture(t);
  const bad = join(f.box.dir, 'conflicting.patch');
  writeFileSync(bad, 'diff --git a/view/missing.cjs b/view/missing.cjs\n--- a/view/missing.cjs\n+++ b/view/missing.cjs\n@@ -1 +1 @@\n-missing old content\n+new content\n');
  await attach(f, 'cannot-apply-view', f.source, bad);
  const rejected = await run(f.box, f.builder, 'submit', String(f.id));
  assert.equal(rejected.code, 1);
  assert.match(rejected.out + rejected.err, /cannot-apply-view/u);
  assert.equal(store.getItem(f.board, f.id).item_status, 'claimed');
  assert.equal(f.box.git(f.builder.root, 'rev-parse', 'HEAD'), f.source);
  assert.equal(f.box.git(f.builder.root, 'status', '--porcelain'), '');
});

test('claimed patch lanes and original builder lane edits remain independently enforced [C7,V4,B2]', async t => {
  const f = await fixture(t);
  const wrong = await run(f.box, f.coordinator, 'patch', 'attach', String(f.id), f.patchFile,
    '--key', 'wrong-author', '--author', f.builder.id, '--source', f.source);
  assert.equal(wrong.code, 1);
  assert.match(wrong.out + wrong.err, /OUTSIDE_LANE/u);
  await attach(f);
  mkdirSync(join(f.builder.root, 'view'));
  writeFileSync(join(f.builder.root, 'view/illegal.cjs'), 'module.exports = 9;\n');
  f.box.git(f.builder.root, 'add', 'view/illegal.cjs');
  const previous = f.box.env.CODEX_THREAD_ID;
  f.box.env.CODEX_THREAD_ID = f.builder.session;
  let hook;
  try { hook = f.box.tryGit(f.builder.root, 'commit', '-m', 'feat(core): forbidden lane edit [G1]'); }
  finally { if (previous === undefined) delete f.box.env.CODEX_THREAD_ID; else f.box.env.CODEX_THREAD_ID = previous; }
  assert.notEqual(hook.status, 0);
  assert.match(hook.stderr, /outside|lane|view/iu);
  const submitted = await run(f.box, f.builder, 'submit', String(f.id));
  assert.equal(submitted.code, 1);
  assert.match(submitted.out + submitted.err, /DIRTY|OUTSIDE_LANE/u);
  assert.equal(store.getItem(f.board, f.id).item_status, 'claimed');
});

test('claimed attachment replay preserves its state and rejects historical protocol downgrade [C7,H16]', async t => {
  const f = await fixture(t);
  const replica = openBoard(':memory:');
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(f.board));
  const move = prepareEngineMove(f.board, 'attachItemPatch', [f.id, { agentId: 'coordinator', key: 'replay-view',
    commit: f.source, patch: f.patch, author: f.author.id }], { id: 'claimed-companion-fixture' });
  assert.equal(move.args[1].presubmit, true);
  assert.ok(move.engine >= ITEM_PATCH_SUBMIT_ENGINE);
  assert.throws(() => applyEngineMove(replica, { ...move, engine: ITEM_PATCH_ENGINE },
    { sequence: 1, at: '2026-10-28T00:00:00.000Z' }), { code: 'RELAY_MOVE' });
  const result = applyEngineMove(replica, move, { sequence: 1, at: '2026-10-28T00:00:00.000Z' });
  assert.equal(result.error, undefined);
  assert.equal(store.getItem(replica, f.id).item_status, 'claimed');
  assert.equal(store.getItem(replica, f.id).item_owner, f.builder.id);
  assert.equal(store.itemPatches(replica, f.id)[0].commit, f.source);
  assert.deepEqual(applyEngineMove(replica, move, { sequence: 1, at: '2026-10-28T00:00:00.000Z' }), result);
});

test('unproved or changed companion binding cannot be sealed as original-head submit proof [C7,V4,H16]', async t => {
  const f = await fixture(t);
  await attach(f);
  const binding = prepareItemPatchSubmit(f.builder.root, f.board, store.getItem(f.board, f.id), f.source);
  assert.throws(() => sealItemPatchSubmit(f.board, f.id, { agentId: f.builder.id, commit: f.source,
    tree: binding.sourceTree }), { code: 'ITEM_PATCH_CHANGED' });
  assert.throws(() => sealItemPatchSubmit(f.board, f.id, { agentId: f.builder.id, commit: f.source,
    tree: binding.sourceTree, companion: { ...binding, receiptIds: ['not-a-native-proof'] } }), { code: 'ITEM_PATCH_CHANGED' });
  document(await run(f.box, f.coordinator, 'patch', 'remove', String(f.id), 'approved-view'));
  assert.throws(() => sealItemPatchSubmit(f.board, f.id, { agentId: f.builder.id, commit: f.source,
    tree: binding.sourceTree, companion: { ...binding, receiptIds: ['not-a-native-proof'] } }), { code: 'ITEM_PATCH_CHANGED' });
});


test('coordinator removal during the actual gate prevents sealing its superseded companion proof [C7,V4,H16]', async t => {
  const f = await fixture(t, { hold: true });
  await attach(f);
  const previous = f.box.env.CODEX_THREAD_ID;
  f.box.env.CODEX_THREAD_ID = f.builder.session;
  let child;
  try { child = f.helpers.launch(f.box, f.builder.root, process.execPath,
    [fileURLToPath(new URL('../../../pullboard.js', import.meta.url)), 'submit', String(f.id), '--no-next', '--json']); }
  finally { if (previous === undefined) delete f.box.env.CODEX_THREAD_ID; else f.box.env.CODEX_THREAD_ID = previous; }
  try {
    await f.helpers.waitFor(() => existsSync(f.entered), 'the actual frozen companion check', 60000); // budget: failure hang ceiling for admitted child startup; no elapsed-time assertion.
    document(await run(f.box, f.coordinator, 'patch', 'remove', String(f.id), 'approved-view'));
  } finally { writeFileSync(f.release, 'released'); }
  const completed = await child.closed;
  assert.equal(completed.code, 1, child.stdoutText + child.stderrText);
  assert.match(child.stdoutText + child.stderrText, /ITEM_PATCH_CHANGED/u);
  assert.equal(store.getItem(f.board, f.id).item_status, 'claimed');
  assert.equal(store.events(f.board).filter(event => event.item_id === f.id && event.event_kind === 'submit').length, 0);
  assert.ok(store.proofReceipts(f.board, f.id).some(receipt => receipt.exitCode === 0),
    'the actual superseded gate completed; it was not relabeled as a valid current submit');
});


test('companion phases preserve zero, criterion-only deferred and blank-check proof-only policy [C7,V4,H16]', async t => {
  for (const mode of [{ deferred: true }, { check: '' }, { deferred: true, check: '' }]) {
    const f = await fixture(t, mode);
    await attach(f);
    document(await run(f.box, f.builder, 'submit', String(f.id)));
    const detail = JSON.parse(store.events(f.board).filter(row => row.event_kind === 'submit' && row.item_id === f.id).at(-1).event_detail);
    assert.deepEqual(detail.companion.phases.map(phase => phase.role), mode.deferred && mode.check === '' ? [] : [mode.deferred ? 'criterion' : 'proof']);
    const options = { ...detail, agentId: f.builder.id };
    assert.equal(sealItemPatchSubmit(f.board, f.id, options), options);
  }
});
