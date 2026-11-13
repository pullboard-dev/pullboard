/** A claimed companion's proof seals only against the exact board state it was made on [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as store from '../../../../../../packages/store/index.js';
import { openBoard } from '../../../../../lib/index.js';
import { prepareItemPatchSubmit } from '../../../../../../packages/items/index.js';
import { sealItemPatchSubmit } from '../../../../../../packages/items/index.js';
import { prepareEngineMove } from '../../../../../../packages/state/index.js';
import { applyEngineMove } from '../../../../../../packages/state/index.js';
import { exportBoard } from '../../../../../../packages/store/index.js';
import { importBoard } from '../../../../../../packages/store/index.js';
import { ITEM_PATCH_ENGINE } from '../../../../../../packages/state/light.js';
import { ITEM_PATCH_SUBMIT_ENGINE } from '../../../../../../packages/state/light.js';
import { reviveFixtureLocalRunner } from '../../../../tests/fixtures/runner/local-start.js';
import { whenRunnerSettles } from '../../../../tests/fixtures/runner/local-start.js';
import { settleSubmit } from '../../../../tests/fixtures/submit/settle.js';
import { document } from '../../../../tests/fixtures/companion/presubmit.js';
import { run } from '../../../../tests/fixtures/companion/presubmit.js';
import { fixture } from '../../../../tests/fixtures/companion/presubmit.js';
import { attach } from '../../../../tests/fixtures/companion/presubmit.js';

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
  // The pulled gate runs the held frozen check on a runner; the submit returns queued at once.
  // A launched child returns at once; the in-process runner of box.run would wait on the job, which waits on the held check.
  const previous = f.box.env.CODEX_THREAD_ID;
  f.box.env.CODEX_THREAD_ID = f.builder.session;
  let child;
  try { child = f.helpers.launch(f.box, f.builder.root, process.execPath,
    [fileURLToPath(new URL('../../../../pullboard.js', import.meta.url)), 'submit', String(f.id), '--no-next', '--json']); }
  finally { if (previous === undefined) delete f.box.env.CODEX_THREAD_ID; else f.box.env.CODEX_THREAD_ID = previous; }
  const queued = JSON.parse(((await child.closed), child.stdoutText).slice(child.stdoutText.indexOf('{')));
  const pid = queued.localRunner?.pid;
  if (pid) t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });
  reviveFixtureLocalRunner(f.box.repo, f.box.env);
  try {
    await f.helpers.waitFor(() => existsSync(f.entered), 'the actual frozen companion check', 60000); // budget: failure hang ceiling for runner startup; no elapsed-time assertion.
    document(await run(f.box, f.coordinator, 'patch', 'remove', String(f.id), 'approved-view'));
  } finally { writeFileSync(f.release, 'released'); }
  // The job is done once the runner posts its receipt; the board then refuses to seal the removed companion.
  const shown = await whenRunnerSettles(f.box.env, async () => {
    const read = JSON.parse((await f.box.run(f.box.repo, 'show', String(f.id), '--json', '--no-next')).out);
    return read.gateJob?.step === 'done' ? read : null;
  }, { deadlineMs: 120_000, what: 'the held companion gate job' }); // Budget: runaway ceiling for the runner to finish the held check.
  assert.match(JSON.stringify(shown) + JSON.stringify(store.itemThread(f.board, f.id)), /ITEM_PATCH_CHANGED/u);
  assert.equal(store.getItem(f.board, f.id).item_status, 'claimed');
  assert.equal(store.events(f.board).filter(event => event.item_id === f.id && event.event_kind === 'submit').length, 0);
  assert.ok(store.proofReceipts(f.board, f.id).some(receipt => receipt.exitCode === 0),
    'the actual superseded gate completed; it was not relabeled as a valid current submit');
});

test('companion phases preserve zero, criterion-only deferred and blank-check proof-only policy [C7,V4,H16]', async t => {
  for (const mode of [{ deferred: true }, { check: '' }, { deferred: true, check: '' }]) {
    const f = await fixture(t, mode);
    await attach(f);
    await settleSubmit(t, f.box, document(await run(f.box, f.builder, 'submit', String(f.id))));
    assert.equal(store.getItem(f.board, f.id).item_status, 'submitted', JSON.stringify(mode) + ' ' + JSON.stringify(store.itemThread(f.board, f.id).slice(-3)));
    const detail = JSON.parse(store.events(f.board).filter(row => row.event_kind === 'submit' && row.item_id === f.id).at(-1).event_detail);
    assert.deepEqual(detail.companion.phases.map(phase => phase.role), mode.deferred && mode.check === '' ? [] : [mode.deferred ? 'criterion' : 'proof']);
    const options = { ...detail, agentId: f.builder.id, pulledPlan: { phases: detail.companion.phases, proofFiles: detail.submissionProof.files, full: detail.submissionProof.full,
      deferred: detail.submissionProof.deferred, deferredFiles: detail.submissionProof.deferredFiles } };
    assert.equal(sealItemPatchSubmit(f.board, f.id, options), options);
  }
});
