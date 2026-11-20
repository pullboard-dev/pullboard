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
import { importBoard } from '../../../../../packages/store/index.js';

/** Run the private project's real CLI and require its structured successful response. */
async function document(box, root, ...args) {
  const result = await box.runIn(root, ...args, '--json');
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  return JSON.parse(result.out);
}

test('cli.journeys-spec-approval-baseline.malformed-jsonl-record-shapes-stay-unconfirmed: malformed JSONL record shapes stay unconfirmed in status and the API [A9,S1,S19,P6]', async t => {
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

test('cli.journeys-spec-approval-baseline.a-board-s-approval-baseline-is: a board\'s approval baseline is taken once and never blesses later edits [I10,A9,S1,P6]', async t => {
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

test('cli.journeys-spec-approval-baseline.an-upgraded-board-stays-pending-until: an upgraded board stays pending until a coordinator command in the main checkout [I10,A9,H16,S1]', async t => {
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
