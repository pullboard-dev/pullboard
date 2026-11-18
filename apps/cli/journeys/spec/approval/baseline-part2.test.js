/** An approval baseline stays ordered, valid and diagnostic across replay, restore and refusal [H16,A9,S1,P6]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { SPEC_APPROVAL_ENGINE } from '../../../../../packages/state/light.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { importBoard } from '../../../../../packages/store/index.js';
import { applyEngineMove } from '../../../../../packages/state/index.js';
import { applyRelayMove } from '../../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../../packages/state/index.js';

/** Run the private project's real CLI and require its structured successful response. */
async function document(box, root, ...args) {
  const result = await box.runIn(root, ...args, '--json');
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  return JSON.parse(result.out);
}

test('cli.journeys-spec-approval-baseline-part2.an-approval-baseline-is-ordered-once: an approval baseline is ordered once with authenticated engine68 replay [H16,S1,P6]', t => {
  const first = openBoard(':memory:');
  const replica = openBoard(':memory:');
  t.after(() => { store.closeBoard(first); store.closeBoard(replica); });
  store.register(first, { lane: 'coordinator', path: '/private-baseline-coordinator' });
  const agent = store.register(first, { lane: 'core', path: '/private-baseline-agent' });
  importBoard(replica, exportBoard(first));
  const baseline = { version: 1, file: 'SPEC.md', anchor: null,
    rows: [{ id: 'G1', text: 'An existing row.', source: '- G1 [approved, must] An existing row. | gate: review' }] };
  const deniedLane = prepareEngineMove(first, 'recordSpecApprovalBaseline', [{ agentId: agent, baseline }]);
  const laneMeta = { sequence: 1, at: '2026-10-21T11:59:59Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture', agent } };
  const laneRefusal = applyRelayMove(first, deniedLane, laneMeta);
  assert.equal(laneRefusal.error.code, 'COORDINATOR_ONLY');
  assert.deepEqual(applyRelayMove(replica, deniedLane, laneMeta), laneRefusal);
  assert.equal(store.specApprovalBaseline(first), null, 'a lane cannot seed the first snapshot');
  const move = prepareEngineMove(first, 'recordSpecApprovalBaseline', [{ agentId: 'coordinator', baseline }]);
  assert.throws(() => applyEngineMove(first, { ...move, engine: SPEC_APPROVAL_ENGINE - 1 },
    { sequence: 2, at: '2026-10-21T12:00:00Z' }), { code: 'RELAY_MOVE' });
  const meta = { sequence: 2, at: '2026-10-21T12:00:00Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture', agent: 'coordinator' } };
  const result = applyRelayMove(first, move, meta);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual(applyRelayMove(replica, move, meta), result);
  assert.deepEqual(store.specApprovalBaseline(first), baseline);
  assert.deepEqual(store.specApprovalBaseline(replica), baseline);
  assert.deepEqual(applyRelayMove(first, move, meta), result, 'repeated delivery returns the original receipt');
  const second = prepareEngineMove(first, 'recordSpecApprovalBaseline', [{ agentId: 'coordinator', baseline: { ...baseline, rows: [] } }]);
  const repeated = applyRelayMove(first, second, { ...meta, sequence: 3 });
  assert.equal(repeated.error, undefined, JSON.stringify(repeated));
  assert.deepEqual(store.specApprovalBaseline(first), baseline, 'later snapshots cannot replace the original set');
  const denied = applyRelayMove(replica, second, { ...meta, sequence: 3,
    sender: { kind: 'agent', userId: 'fixture', agent: 'unrelated-seat' } });
  assert.equal(denied.error.code, 'RELAY_SENDER_MISMATCH');
  assert.deepEqual(store.specApprovalBaseline(replica), baseline);
});

for (const change of ['metadata changed', 'metadata missing']) {
  test(`a partial baseline restore stays invalid instead of blessing later rows: ${change} [H16,S1,P6]`, t => {
    const original = openBoard(':memory:');
    const restored = openBoard(':memory:');
    t.after(() => { store.closeBoard(original); store.closeBoard(restored); });
    store.register(original, { lane: 'coordinator', path: '/private-baseline-restore' });
    const baseline = { version: 1, file: 'SPEC.md', anchor: null, rows: [] };
    store.recordSpecApprovalBaseline(original, { agentId: 'coordinator', baseline });
    const snapshot = exportBoard(original);
    if (change === 'metadata missing') {
      snapshot.tables.board_meta = snapshot.tables.board_meta.filter(row => row.meta_key !== 'spec_approval_baseline');
    } else {
      snapshot.tables.board_meta.find(row => row.meta_key === 'spec_approval_baseline').meta_value = JSON.stringify({ ...baseline,
        rows: [{ id: 'G99', text: 'Later row.', source: '- G99 [approved, must] Later row. | gate: review' }] });
    }
    importBoard(restored, snapshot);
    assert.throws(() => store.specApprovalBaseline(restored), { code: 'SPEC_APPROVAL_BASELINE' },
      'one changed or missing half must not silently establish a different trusted snapshot');
    assert.equal(store.specApprovalBaselineExists(restored), true, 'an existing event prevents automatic reseeding');
    assert.throws(() => store.recordSpecApprovalBaseline(restored, { agentId: 'coordinator', baseline }),
      { code: 'SPEC_APPROVAL_BASELINE' }, 'a later bootstrap cannot reset the invalid marker');
    assert.deepEqual(exportBoard(restored).tables, snapshot.tables);
  });
}

test('cli.journeys-spec-approval-baseline-part2.an-invalid-baseline-stays-diagnostic-while: an invalid baseline stays diagnostic while flag work remains usable and refuse stays strict [A9,H16,S1,P6]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const item = (await document(box, box.repo, 'add', 'web', 'Corrupt baseline policy fixture',
    '--specs', 'G1', '--criterion', 'The private fixture stays unconfirmed.')).item.item_id;
  const exported = await document(box, box.repo, 'export');
  const baseline = exported.tables.board_meta.find(row => row.meta_key === 'spec_approval_baseline');
  assert.ok(baseline);
  baseline.meta_value = '{broken-baseline';
  const file = join(box.dir, 'corrupt-export.json');
  writeFileSync(file, JSON.stringify(exported));
  const root = join(box.dir, 'flag-clone');
  box.git(box.repo, 'clone', '-q', box.repo, root);
  await document(box, root, 'import', file);
  const state = await document(box, root, 'status');
  assert.equal(state.specApprovalBaseline.pending, false, 'invalid is not an absent legacy baseline');
  assert.equal(state.specApprovalBaseline.invalid, true);
  assert.ok(state.specApprovalEvidenceErrors.some(error => error.code === 'SPEC_APPROVAL_BASELINE'));
  assert.ok(state.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'));
  // A public view must address only this imported clone, not its same-id source project.
  writeFileSync(join(box.env.PULLBOARD_HOME, 'projects.json'), JSON.stringify({ projects: [] }));
  const view = await helpers.startView(box, root);
  t.after(view.stop);
  const api = (await view.state(root)).project;
  assert.equal(api.specApprovalBaseline.pending, false);
  assert.equal(api.specApprovalBaseline.invalid, true);
  assert.ok(api.specApprovalEvidenceErrors.some(error => error.code === 'SPEC_APPROVAL_BASELINE'));
  assert.ok(api.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'));
  await document(box, root, 'shout', 'all', 'Flag mode still permits ordinary work with a diagnostic');
  const after = await document(box, root, 'export');
  assert.equal(after.tables.board_meta.find(row => row.meta_key === 'spec_approval_baseline').meta_value, '{broken-baseline');
  assert.deepEqual(after.tables.event.filter(row => row.event_kind === 'spec_approval_baseline'),
    exported.tables.event.filter(row => row.event_kind === 'spec_approval_baseline'), 'no reset or invented baseline event');

  const strict = join(box.dir, 'refuse-clone');
  box.git(box.repo, 'clone', '-q', box.repo, strict);
  const configFile = join(strict, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, spec: { file: 'SPEC.md', agentApproval: 'refuse' } }));
  box.git(strict, 'add', 'pullboard.json');
  box.git(strict, 'commit', '-q', '-m', 'chore: choose explicit refusal in private fixture');
  await document(box, strict, 'import', file);
  const web = join(box.dir, 'strict-web');
  box.git(strict, 'worktree', 'add', '-q', '-b', 'web/strict', web);
  await document(box, web, 'join', 'web');
  const claimed = await box.runIn(web, 'claim', String(item), '--json');
  assert.equal(claimed.code, 1);
  assert.equal(JSON.parse(claimed.out).error.code, 'AGENT_APPROVAL_REQUIRED',
    'the actual claim reaches and enforces the explicit policy instead of trusting invalid metadata');
});
