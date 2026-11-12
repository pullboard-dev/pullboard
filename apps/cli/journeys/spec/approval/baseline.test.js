/** Hand-written approval is visible without becoming a person's decision [S1,B26,P6]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
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

test('malformed JSONL record shapes stay unconfirmed in status and the API [A9,S1,S19,P6]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  for (const signed of [false, true]) {
    const box = helpers.project('true');
    if (signed) {
      const key = join(box.dir, 'private-shape-signing-key');
      const made = runFixtureChild('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env: box.env, encoding: 'utf8' });
      assert.equal(made.status, 0, made.failure ?? made.stderr);
      box.git(box.repo, 'config', 'user.signingkey', key);
      await document(box, box.repo, 'spec', 'signers', 'add', '--key', key + '.pub', '--by', 'fixture-person');
    }
    await document(box, box.repo, 'spec', 'approve', 'G1', ...(signed ? ['--by', 'fixture-person'] : []));
    const view = await helpers.startView(box, box.repo);
    t.after(view.stop);
    assert.equal((await view.state(box.repo)).project.spec.find(row => row.id === 'G1').agentApproval, null);
    mkdirSync(join(box.repo, '.pullboard'), { recursive: true });
    for (const value of [null, [], true, 0, 'not a record']) {
      writeFileSync(join(box.repo, '.pullboard/signoffs.jsonl'), JSON.stringify(value) + '\n');
      const status = await document(box, box.repo, 'status');
      assert.ok(status.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'),
        `invalid receipt shape stays unconfirmed, signed=${signed}, value=${JSON.stringify(value)}`);
      assert.ok(status.specApprovalEvidenceErrors.some(error => error.code === 'BAD_SIGNOFFS'));
      const state = (await view.state(box.repo)).project;
      assert.ok(state.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'));
      assert.ok(state.specApprovalEvidenceErrors.some(error => error.code === 'BAD_SIGNOFFS'));
    }
    const id = (await document(box, box.repo, 'add', 'web', 'A malformed receipt does not opt into refusal',
      '--specs', 'G1', '--criterion', 'A real fixture.')).item.item_id;
    mkdirSync(join(box.web, '.pullboard'), { recursive: true });
    writeFileSync(join(box.web, '.pullboard/signoffs.jsonl'), 'null\n');
    assert.equal((await box.runIn(box.web, 'claim', String(id))).code, 0, 'default flag leaves engineering claims usable even in the malformed checkout');
  }
});

test("a board's approval baseline is taken once and never blesses later edits [I10,A9,S1,P6]", async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const sandbox = helpers.sandbox();
  const repo = join(sandbox.dir, 'existing-project');
  mkdirSync(repo);
  sandbox.git(repo, 'init', '-q', '-b', 'main');
  const initial = '# Existing requirements\n\n## G · Goals\n- G7 [approved, must] The existing requirement. | gate: review\n';
  writeFileSync(join(repo, 'SPEC.md'), initial);
  const box = { ...sandbox, repo };
  await document(box, repo, 'init');
  const first = await document(box, repo, 'status');
  assert.equal(first.needs.some(need => need.kind === 'agent-approved' && need.id === 'G7'), false,
    'the existing approved row is a first-open compatibility baseline, not a new person decision');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: preserve the initial project');
  writeFileSync(join(repo, 'SPEC.md'), initial + '- G8 [approved, must] A later approval needs the person. | gate: review\n');
  assert.ok((await document(box, repo, 'status')).needs.some(need => need.kind === 'agent-approved' && need.id === 'G8'));
  await document(box, repo, 'init');
  assert.ok((await document(box, repo, 'status')).needs.some(need => need.kind === 'agent-approved' && need.id === 'G8'),
    'repeating setup cannot replace or expand the original baseline');
  const view = await helpers.startView(box, repo);
  t.after(view.stop);
  assert.ok((await view.state(repo)).project.needs.some(need => need.kind === 'agent-approved' && need.id === 'G8'),
    'another process and the actual API retain the original baseline');
  writeFileSync(join(repo, 'SPEC.md'), initial.replace('existing requirement.', 'changed requirement.'));
  assert.ok((await document(box, repo, 'status')).needs.some(need => need.kind === 'agent-approved' && need.id === 'G7'),
    'an existing id cannot borrow its baseline approval for different source bytes');
  await document(box, repo, 'spec', 'approve', 'G7');
  assert.equal((await document(box, repo, 'status')).needs.some(need => need.kind === 'agent-approved' && need.id === 'G7'), false,
    'one exact person decision confirms a changed baseline row');
});

test('an upgraded board stays pending until a coordinator command in the main checkout [I10,A9,H16,S1]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const legacy = await document(box, box.repo, 'export');
  // A public legacy-format snapshot has neither the new metadata nor its new event.
  legacy.tables.board_meta = legacy.tables.board_meta.filter(row => row.meta_key !== 'spec_approval_baseline');
  legacy.tables.event = legacy.tables.event.filter(row => row.event_kind !== 'spec_approval_baseline');
  const root = join(box.dir, 'legacy-clone');
  // Model an already located legacy checkout; view startup need not repair its coordinator path.
  legacy.tables.agent.find(agent => agent.agent_id === 'coordinator').agent_path = root;
  box.git(box.repo, 'clone', '-q', box.repo, root);
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  try { importBoard(board, legacy); } finally { store.closeBoard(board); }
  const lane = join(box.dir, 'legacy-lane');
  box.git(root, 'worktree', 'add', '-q', '-b', 'web/legacy', lane);
  await document(box, lane, 'join', 'web');
  await document(box, lane, 'shout', 'all', 'A lane command cannot establish the compatibility baseline');
  const before = await document(box, root, 'export');
  const first = await document(box, root, 'status');
  assert.equal(first.specApprovalBaseline.pending, true);
  assert.equal(first.needs.some(need => need.kind === 'agent-approved'), false);
  // The imported clone shares the source board id; expose only this clone to the API fixture.
  const registryFile = join(box.env.PULLBOARD_HOME, 'projects.json');
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
  writeFileSync(registryFile, JSON.stringify({ ...registry, projects: registry.projects.filter(project => project.root === root) }) + '\n');
  const view = await helpers.startView(box, root);
  t.after(view.stop);
  const state = (await view.state(root)).project;
  assert.equal(state.specApprovalBaseline.pending, true);
  assert.equal(state.needs.some(need => need.kind === 'agent-approved'), false);
  assert.deepEqual((await document(box, root, 'export')).tables, before.tables, 'status/API reads cannot seed or rewrite the legacy board');
  await document(box, root, 'shout', 'all', 'First coordinator command establishes the compatibility baseline');
  const ready = await document(box, root, 'status');
  assert.equal(ready.specApprovalBaseline.pending, false);
  assert.equal(ready.needs.some(need => need.kind === 'agent-approved'), false);
  const specFile = join(root, 'SPEC.md');
  writeFileSync(specFile, readFileSync(specFile, 'utf8') + '- G3 [approved, must] Later agent approval. | gate: review\n');
  const later = await document(box, root, 'status');
  assert.ok(later.needs.some(need => need.kind === 'agent-approved' && need.id === 'G3'));
  await document(box, root, 'shout', 'all', 'A later ordered command cannot expand the baseline');
  assert.ok((await view.state(root)).project.needs.some(need => need.kind === 'agent-approved' && need.id === 'G3'));
  const after = await document(box, root, 'export');
  assert.equal(after.tables.event.filter(row => row.event_kind === 'spec_approval_baseline').length, 1);
});

test('an approval baseline is ordered once with authenticated engine68 replay [H16,S1,P6]', t => {
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

test('an invalid baseline stays diagnostic while flag work remains usable and refuse stays strict [A9,H16,S1,P6]', async t => {
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
