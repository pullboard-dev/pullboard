/** Hand-written approval is visible without becoming a person's decision [S1,B26,P6]. */
import { verifiedPasskeyRowDecision } from '../../../../packages/person/index.js';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { configFromSource } from '../../../../packages/config/index.js';
import { gitReadSignature } from '../../../../packages/git/index.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  captureSpecApprovalBaseline,
  specApprovalState,
} from '../../../../packages/spec/index.js';
import { SPEC_APPROVAL_ENGINE } from '../../../../packages/state/light.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import {
  applyEngineMove,
  applyRelayMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';

/** Run the private project's real CLI and require its structured successful response. */
function document(box, root, ...args) {
  const result = box.run(root, ...args, '--json');
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  return JSON.parse(result.out);
}

test('a row approved without a person move reads as agent-approved until the person confirms it [S1,B26,P6]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  // This normal fixture's setup commit writes approved rows, without any person row decision.
  const box = helpers.project('true');
  const sourceCommit = box.git(box.repo, 'rev-parse', 'HEAD');
  const initial = document(box, box.repo, 'status');
  const unconfirmed = (initial.needs ?? []).find(need => need.kind === 'agent-approved' && need.id === 'G1');
  assert.ok(unconfirmed, 'an approved row with no person decision must appear in Needs you as agent-approved');
  assert.equal(unconfirmed.commit, sourceCommit, 'the flag names the commit containing the unconfirmed row');
  assert.ok(unconfirmed.agent, 'the available author attribution is shown, never inferred to be human approval');
  assert.match(unconfirmed.text, /agent-approved/u);

  const added = document(box, box.repo, 'add', 'web', 'Work on the unconfirmed requirement',
    '--specs', 'G1', '--criterion', 'The fixture page exists.');
  const id = added.item.item_id;
  assert.equal(box.run(box.web, 'claim', String(id)).code, 0, 'the default flag does not block work');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/page.js'), 'export const page = true;\n');
  box.git(box.web, 'add', 'web/page.js');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): add the fixture page [G1]');
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  document(box, box.web, 'submit', String(id), '--wait', '--no-next');
  const review = join(box.dir, 'independent-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  // An unrouted item is strong, so its reviewer joins strong.
  document(box, review, 'join', 'api', '--route', 'strong');
  const verified = box.run(review, 'verify', String(id), 'accept', '--note', 'The real fixture gate passed on the submitted commit.');
  assert.equal(verified.code, 0, `${verified.out}\n${verified.err}`);
  assert.match(verified.out, /verified against agent-approved G1/u);
  const exported = document(box, box.repo, 'export');
  const acceptance = exported.tables.event.findLast(event => event.item_id === id && event.event_kind === 'accept');
  assert.ok(acceptance, 'the normal independent verification produced a receipt');
  assert.match(acceptance.event_detail, /verified against agent-approved G1/u);
  const ledger = box.run(box.repo, 'ledger');
  assert.equal(ledger.code, 0, ledger.err);
  assert.match(ledger.out, /verified against agent-approved G1/u);

  // Only this isolated fixture simulates a marked agent and a separate ordinary person terminal.
  const agent = runFixtureChild(process.execPath, [helpers.BIN, 'spec', 'approve', 'G1', '--json'], {
    cwd: box.web, env: { ...box.env, CLAUDECODE: '1' }, encoding: 'utf8',
  });
  assert.equal(agent.status, 1);
  assert.equal(JSON.parse(agent.stdout).error.code, 'B26_PERSON_CHANNEL', 'an agent cannot confirm its own approval');
  document(box, box.repo, 'spec', 'approve', 'G1');
  const confirmed = document(box, box.repo, 'status');
  assert.equal((confirmed.needs ?? []).some(need => need.kind === 'agent-approved' && need.id === 'G1'), false,
    'one person decision confirms the exact row without a separate apply step');
  const after = box.run(box.repo, 'ledger');
  assert.equal(after.code, 0, after.err);
  assert.doesNotMatch(after.out, /verified against agent-approved G1/u, 'the current ledger reflects the confirmation');
  const kept = document(box, box.repo, 'export').tables.event.find(event => event.event_id === acceptance.event_id);
  assert.equal(kept.event_detail, acceptance.event_detail, 'confirmation never rewrites the historical verification receipt');
});

test('agent approval settings preserve the filename form and reject ambiguous choices [S1,P6]', () => {
  assert.equal(configFromSource('{}').specAgentApproval, 'flag');
  assert.equal(configFromSource('{"spec":"requirements.md"}').spec, 'requirements.md');
  for (const agentApproval of ['flag', 'allow', 'refuse']) {
    const config = configFromSource(JSON.stringify({ spec: { file: 'requirements.md', agentApproval } }));
    assert.equal(config.spec, 'requirements.md');
    assert.equal(config.specAgentApproval, agentApproval);
  }
  for (const spec of [null, [], { file: 'SPEC.md', agentApproval: null }, { file: 'SPEC.md', agentApproval: 'trust' }]) {
    assert.throws(() => configFromSource(JSON.stringify({ spec })), error => error.code === 'BAD_CONFIG');
  }
  // Forward compatibility landed after this case: an unknown key warns and is ignored, so it can never grant approval.
  const unknown = configFromSource(JSON.stringify({ spec: { file: 'SPEC.md', agentApproval: 'flag', agent: 'person' } }));
  assert.equal(unknown.specAgentApproval, 'flag', 'an unknown spec key changes no approval setting');
});

test('allow suppresses approval calls and explicit refuse protects a new claim [S1,B26,P6]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  for (const mode of ['allow', 'refuse']) {
    const box = helpers.project('true');
    const file = join(box.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...config, spec: { file: 'SPEC.md', agentApproval: mode } }, null, 2) + '\n');
    box.git(box.repo, 'add', 'pullboard.json');
    box.git(box.repo, 'commit', '-q', '-m', 'chore(config): choose approval policy');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    const initial = document(box, box.repo, 'status');
    assert.equal(initial.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), mode !== 'allow');
    const id = document(box, box.repo, 'add', 'web', 'Policy-controlled fixture', '--specs', 'G1', '--criterion', 'A real fixture.').item.item_id;
    const claimed = box.run(box.web, 'claim', String(id), '--json');
    if (mode === 'allow') assert.equal(claimed.code, 0, `${claimed.out}\n${claimed.err}`);
    else {
      assert.equal(claimed.code, 1);
      assert.equal(JSON.parse(claimed.out).error.code, 'AGENT_APPROVAL_REQUIRED');
      document(box, box.repo, 'spec', 'approve', 'G1');
      assert.equal(box.run(box.web, 'claim', String(id)).code, 0, 'the exact person decision unblocks an explicit refuse policy');
    }
  }
});

test('confirmation follows the exact row and an unsigned ledger cannot impersonate it [S1,S19,P6]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const before = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const line = before.split('\n').find(text => text.startsWith('- G1 '));
  mkdirSync(join(box.repo, '.pullboard'), { recursive: true });
  writeFileSync(join(box.repo, '.pullboard/signoffs.jsonl'), JSON.stringify({ version: 1, type: 'row-decision', kind: 'spec',
    file: 'SPEC.md', id: 'G1', decision: 'approve', by: 'person', source: line, replacement: line, text: 'The page renders.' }) + '\n');
  assert.ok(document(box, box.repo, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'),
    'a hand-written unsigned receipt is not person approval');
  document(box, box.repo, 'spec', 'approve', 'G1');
  assert.equal(document(box, box.repo, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), false);
  writeFileSync(join(box.repo, 'SPEC.md'), before.replace('The page renders.', 'The changed page renders.'));
  const changed = document(box, box.repo, 'status').needs.find(need => need.kind === 'agent-approved' && need.id === 'G1');
  assert.ok(changed, 'an approval of earlier wording cannot confirm a changed row');
  assert.equal(changed.commit, null, 'uncommitted wording never borrows a committed row attribution');
  document(box, box.repo, 'spec', 'approve', 'G1');
  assert.equal(document(box, box.repo, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), false);
});

test('the actual API reports approval calls and accepts one person confirmation [A9,S1,P6]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const view = await helpers.startView(box, box.repo);
  t.after(view.stop);
  const before = (await view.state(box.repo)).project;
  assert.ok(before.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'));
  assert.equal(before.spec.find(row => row.id === 'G1').agentApproval.attribution, 'Git author, seat unknown');
  const confirmed = await view.act(box.repo, { verb: 'spec-approve', args: { ids: 'G1' } });
  assert.equal(confirmed.status, 200);
  const after = (await view.state(box.repo)).project;
  assert.equal(after.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), false);
  assert.equal(after.spec.find(row => row.id === 'G1').agentApproval, null);
});

test('a clone recognizes an exact signed approval without borrowing another board history [S19,S20,P6]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const key = join(box.dir, 'private-fixture-signing-key');
  const made = runFixtureChild('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env: box.env, encoding: 'utf8' });
  assert.equal(made.status, 0, made.failure ?? made.stderr);
  box.git(box.repo, 'config', 'user.signingkey', key);
  document(box, box.repo, 'spec', 'signers', 'add', '--key', key + '.pub', '--by', 'fixture-person');
  const approved = document(box, box.repo, 'spec', 'approve', 'G1', '--by', 'fixture-person');
  assert.ok(approved.decisions[0].signature, 'the fixture person produced an actual SSH signature');
  document(box, box.repo, 'spec', 'apply');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore(spec): preserve the signed approval');
  const clone = join(box.dir, 'signed-clone');
  box.git(box.repo, 'clone', '-q', box.repo, clone);
  const cloneSpec = readFileSync(join(clone, 'SPEC.md'), 'utf8');
  writeFileSync(join(clone, 'SPEC.md'), '# Clone setup\n\n## G · Goals\n');
  document(box, clone, 'init');
  writeFileSync(join(clone, 'SPEC.md'), cloneSpec);
  assert.equal(document(box, clone, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), false,
    'a separate local board verifies the committed signed receipt');
  const view = await helpers.startView(box, clone);
  t.after(view.stop);
  const before = (await view.state(clone)).project;
  assert.equal(before.spec.find(row => row.id === 'G1').agentApproval, null);
  const head = box.git(clone, 'rev-parse', 'HEAD');
  const events = document(box, clone, 'export').tables.event;
  const receiptFile = join(clone, '.pullboard/signoffs.jsonl');
  const receipt = readFileSync(receiptFile, 'utf8');
  rmSync(receiptFile);
  const removed = (await view.state(clone)).project;
  assert.ok(removed.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'),
    'removing only the proof file invalidates a cached confirmation');
  writeFileSync(receiptFile, receipt);
  assert.equal((await view.state(clone)).project.spec.find(row => row.id === 'G1').agentApproval, null,
    'restoring the exact verified proof confirms the row again');
  const records = receipt.trimEnd().split('\n').map(line => JSON.parse(line));
  const decision = records.find(record => record.type === 'row-decision' && record.id === 'G1');
  assert.ok(decision);
  decision.signature = 'invalid SSH signature';
  writeFileSync(receiptFile, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const invalid = (await view.state(clone)).project;
  assert.ok(invalid.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'));
  assert.equal(invalid.specApprovalEvidenceErrors[0].code, 'BAD_SIGNATURE');
  writeFileSync(receiptFile, receipt);
  assert.equal((await view.state(clone)).project.spec.find(row => row.id === 'G1').agentApproval, null);
  assert.equal(box.git(clone, 'rev-parse', 'HEAD'), head, 'proof changes made no Git move');
  assert.deepEqual(document(box, clone, 'export').tables.event, events, 'proof reads made no board event');
  const source = readFileSync(join(clone, 'SPEC.md'), 'utf8');
  writeFileSync(join(clone, 'SPEC.md'), source.replace('gate: web test', 'gate: web stricter-test'));
  assert.ok(document(box, clone, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'),
    'a signed approval does not authorize different gate bytes');
});

test('approval projection leaves a board with no Spec readable [I10,S1,P6]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const id = document(box, box.repo, 'add', 'web', 'An item needs no spec rows').item.item_id;
  rmSync(join(box.repo, 'SPEC.md'));
  assert.equal(document(box, box.repo, 'status').needs.some(need => need.kind === 'agent-approved'), false);
  assert.equal(document(box, box.repo, 'show', String(id)).agentApproved.length, 0);
  assert.deepEqual(document(box, box.repo, 'ledger').items, []);
  const view = await helpers.startView(box, box.repo);
  t.after(view.stop);
  const state = (await view.state(box.repo)).project;
  assert.deepEqual(state.spec, []);
  assert.equal(state.needs.some(need => need.kind === 'agent-approved'), false);
});

test('only new-engine acceptance receipts retain the verification note [H16,S1,P6]', t => {
  const payloads = [];
  const note = 'Fixture verification note; verified against agent-approved G1';
  for (const version of [SPEC_APPROVAL_ENGINE - 1, SPEC_APPROVAL_ENGINE]) {
    const board = openBoard(':memory:');
    t.after(() => store.closeBoard(board));
    const builder = store.register(board, { lane: 'web', path: '/fixture-builder', model: 'Fixture builder' });
    const reviewer = store.register(board, { lane: 'review', path: '/fixture-reviewer', model: 'Fixture reviewer' });
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Versioned receipt' });
    const frozen = { text: JSON.stringify({ rows: [], policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }), digest: 'f'.repeat(64) };
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, head: 'a'.repeat(40), freeze: () => frozen });
    submitFixture(board, id, { agentId: builder, commit: 'b'.repeat(40), tree: 'c'.repeat(40) });
    board.executionEngineVersion = version;
    store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', note, head: 'b'.repeat(40), digest: frozen.digest,
      policy: 'any', check: 'green', review: { commit: 'b'.repeat(40), head: 'b'.repeat(40), trunk: 'a'.repeat(40), paths: [] } });
    const detail = JSON.parse(store.events(board, { itemId: id }).find(event => event.event_kind === 'accept').event_detail);
    assert.equal(detail.note, version >= SPEC_APPROVAL_ENGINE ? note : undefined);
    const { note: recorded, ...historical } = detail;
    payloads.push(historical);
  }
  assert.deepEqual(payloads[0], payloads[1], 'every existing receipt field retains its earlier replay meaning');
});


test('malformed approval evidence stays unconfirmed without blocking default flag work [S1,B26,P6]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  document(box, box.repo, 'spec', 'approve', 'G1');
  assert.equal(document(box, box.repo, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), false);
  mkdirSync(join(box.repo, '.pullboard'), { recursive: true });
  document(box, box.repo, 'spec', 'decline', 'G2', '--reason', 'Not a governing requirement');
  writeFileSync(join(box.repo, '.pullboard/signoffs.jsonl'), '{not valid JSON\n');
  const status = document(box, box.repo, 'status');
  assert.ok(status.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), 'bad proof does not confirm even a board-held decision');
  assert.ok(status.specApprovalEvidenceErrors.some(error => error.code === 'BAD_SIGNOFFS'));
  assert.equal(document(box, box.repo, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G2'), false,
    'one person decline removes the outstanding approval call');
  const id = document(box, box.repo, 'add', 'web', 'Default flag remains usable', '--specs', 'G1', '--criterion', 'A real fixture.').item.item_id;
  // The malformed ledger is in the coordinator checkout; the builder independently sees an unconfirmed row.
  assert.equal(box.run(box.web, 'claim', String(id)).code, 0);
});


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
      document(box, box.repo, 'spec', 'signers', 'add', '--key', key + '.pub', '--by', 'fixture-person');
    }
    document(box, box.repo, 'spec', 'approve', 'G1', ...(signed ? ['--by', 'fixture-person'] : []));
    const view = await helpers.startView(box, box.repo);
    t.after(view.stop);
    assert.equal((await view.state(box.repo)).project.spec.find(row => row.id === 'G1').agentApproval, null);
    mkdirSync(join(box.repo, '.pullboard'), { recursive: true });
    for (const value of [null, [], true, 0, 'not a record']) {
      writeFileSync(join(box.repo, '.pullboard/signoffs.jsonl'), JSON.stringify(value) + '\n');
      const status = document(box, box.repo, 'status');
      assert.ok(status.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'),
        `invalid receipt shape stays unconfirmed, signed=${signed}, value=${JSON.stringify(value)}`);
      assert.ok(status.specApprovalEvidenceErrors.some(error => error.code === 'BAD_SIGNOFFS'));
      const state = (await view.state(box.repo)).project;
      assert.ok(state.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'));
      assert.ok(state.specApprovalEvidenceErrors.some(error => error.code === 'BAD_SIGNOFFS'));
    }
    const id = document(box, box.repo, 'add', 'web', 'A malformed receipt does not opt into refusal',
      '--specs', 'G1', '--criterion', 'A real fixture.').item.item_id;
    mkdirSync(join(box.web, '.pullboard'), { recursive: true });
    writeFileSync(join(box.web, '.pullboard/signoffs.jsonl'), 'null\n');
    assert.equal(box.run(box.web, 'claim', String(id)).code, 0, 'default flag leaves engineering claims usable even in the malformed checkout');
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
  document(box, repo, 'init');
  const first = document(box, repo, 'status');
  assert.equal(first.needs.some(need => need.kind === 'agent-approved' && need.id === 'G7'), false,
    'the existing approved row is a first-open compatibility baseline, not a new person decision');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: preserve the initial project');
  writeFileSync(join(repo, 'SPEC.md'), initial + '- G8 [approved, must] A later approval needs the person. | gate: review\n');
  assert.ok(document(box, repo, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G8'));
  document(box, repo, 'init');
  assert.ok(document(box, repo, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G8'),
    'repeating setup cannot replace or expand the original baseline');
  const view = await helpers.startView(box, repo);
  t.after(view.stop);
  assert.ok((await view.state(repo)).project.needs.some(need => need.kind === 'agent-approved' && need.id === 'G8'),
    'another process and the actual API retain the original baseline');
  writeFileSync(join(repo, 'SPEC.md'), initial.replace('existing requirement.', 'changed requirement.'));
  assert.ok(document(box, repo, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G7'),
    'an existing id cannot borrow its baseline approval for different source bytes');
  document(box, repo, 'spec', 'approve', 'G7');
  assert.equal(document(box, repo, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G7'), false,
    'one exact person decision confirms a changed baseline row');
});

test('an upgraded board stays pending until a coordinator command in the main checkout [I10,A9,H16,S1]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const legacy = document(box, box.repo, 'export');
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
  document(box, lane, 'join', 'web');
  document(box, lane, 'shout', 'all', 'A lane command cannot establish the compatibility baseline');
  const before = document(box, root, 'export');
  const first = document(box, root, 'status');
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
  assert.deepEqual(document(box, root, 'export').tables, before.tables, 'status/API reads cannot seed or rewrite the legacy board');
  document(box, root, 'shout', 'all', 'First coordinator command establishes the compatibility baseline');
  const ready = document(box, root, 'status');
  assert.equal(ready.specApprovalBaseline.pending, false);
  assert.equal(ready.needs.some(need => need.kind === 'agent-approved'), false);
  const specFile = join(root, 'SPEC.md');
  writeFileSync(specFile, readFileSync(specFile, 'utf8') + '- G3 [approved, must] Later agent approval. | gate: review\n');
  const later = document(box, root, 'status');
  assert.ok(later.needs.some(need => need.kind === 'agent-approved' && need.id === 'G3'));
  document(box, root, 'shout', 'all', 'A later ordered command cannot expand the baseline');
  assert.ok((await view.state(root)).project.needs.some(need => need.kind === 'agent-approved' && need.id === 'G3'));
  const after = document(box, root, 'export');
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
  const item = document(box, box.repo, 'add', 'web', 'Corrupt baseline policy fixture',
    '--specs', 'G1', '--criterion', 'The private fixture stays unconfirmed.').item.item_id;
  const exported = document(box, box.repo, 'export');
  const baseline = exported.tables.board_meta.find(row => row.meta_key === 'spec_approval_baseline');
  assert.ok(baseline);
  baseline.meta_value = '{broken-baseline';
  const file = join(box.dir, 'corrupt-export.json');
  writeFileSync(file, JSON.stringify(exported));
  const root = join(box.dir, 'flag-clone');
  box.git(box.repo, 'clone', '-q', box.repo, root);
  document(box, root, 'import', file);
  const state = document(box, root, 'status');
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
  document(box, root, 'shout', 'all', 'Flag mode still permits ordinary work with a diagnostic');
  const after = document(box, root, 'export');
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
  document(box, strict, 'import', file);
  const web = join(box.dir, 'strict-web');
  box.git(strict, 'worktree', 'add', '-q', '-b', 'web/strict', web);
  document(box, web, 'join', 'web');
  const claimed = box.run(web, 'claim', String(item), '--json');
  assert.equal(claimed.code, 1);
  assert.equal(JSON.parse(claimed.out).error.code, 'AGENT_APPROVAL_REQUIRED',
    'the actual claim reaches and enforces the explicit policy instead of trusting invalid metadata');
});

test('an authenticated first baseline cannot grandfather an absent future row [H16,S1,P6]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-baseline-forgery-'));
  const board = openBoard(':memory:');
  const replica = openBoard(':memory:');
  t.after(() => {
    store.closeBoard(board);
    store.closeBoard(replica);
    rmSync(root, { recursive: true, force: true });
  });

  const coordinator = store.register(board, { lane: 'coordinator', path: '/private-baseline-control/coordinator' });
  const agent = store.register(board, { lane: 'core', path: '/private-baseline-control/agent' });
  assert.ok(coordinator);
  importBoard(replica, exportBoard(board));

  const initialSource = [
    '# Private spec fixture',
    '',
    '## Existing',
    '- G1 [approved, must] Existing requirement. | gate: review',
    '',
  ].join('\n');
  writeFileSync(join(root, 'SPEC.md'), initialSource);
  const config = configFromSource('{"spec":"SPEC.md"}');

  const futureRow = '- G99 [approved, must] Future requirement. | gate: review';
  const baseline = {
    version: 1,
    file: 'SPEC.md',
    anchor: 'a'.repeat(40),
    rows: [{ id: 'G99', text: 'Future requirement.', source: futureRow }],
  };
  const move = prepareEngineMove(board, 'recordSpecApprovalBaseline', [{ agentId: agent, baseline }]);
  const sender = { kind: 'agent', userId: 'private-control-user', agent };
  const receipt = { sequence: 1, at: '2026-10-21T12:00:00.000Z', kind: 'move', sender };
  const outcome = applyRelayMove(board, move, receipt);
  assert.equal(outcome.error?.code, 'COORDINATOR_ONLY', JSON.stringify(outcome));
  assert.deepEqual(applyRelayMove(replica, move, receipt), outcome,
    'a second replica refuses the same authenticated lane snapshot');
  assert.equal(store.specApprovalBaseline(board), null);
  assert.equal(store.specApprovalBaseline(replica), null);
  assert.equal(specApprovalState(root, { board, config }, { store, verifiedPasskeyRowDecision }).baselinePending, true);
  const captured = captureSpecApprovalBaseline(root, config);
  const authorized = prepareEngineMove(board, 'recordSpecApprovalBaseline', [{ agentId: coordinator, baseline: captured }]);
  const authorizedReceipt = { ...receipt, sequence: 2, sender: { ...sender, agent: coordinator } };
  const accepted = applyRelayMove(board, authorized, authorizedReceipt);
  assert.equal(accepted.error, undefined, JSON.stringify(accepted));
  assert.deepEqual(applyRelayMove(replica, authorized, authorizedReceipt), accepted);
  assert.deepEqual(store.specApprovalBaseline(board), captured);

  // The row was absent from the source at the time the baseline move was created.
  writeFileSync(join(root, 'SPEC.md'), initialSource + `${futureRow}\n`);
  const projected = specApprovalState(root, { board, config }, { store, verifiedPasskeyRowDecision });
  assert.ok(projected.rows.some(row => row.id === 'G99'),
    'a later approved row absent from the captured source must remain agent-approved until a person confirms it');
});


test('cached origins follow dirty lines and changed history while person decisions stay live [S1,B26,N26]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const sandbox = helpers.sandbox();
  sandbox.env.GIT_AUTHOR_DATE = '2001-02-03T04:05:06+00:00';
  sandbox.env.GIT_COMMITTER_DATE = '2004-05-06T07:08:09+05:30';
  const box = helpers.project('true', sandbox);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const config = configFromSource(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  const read = (root = box.repo) => specApprovalState(root, { board, config }, { store, verifiedPasskeyRowDecision }).rows.find(row => row.id === 'G1');
  const original = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const first = read();
  assert.equal(first.commit, box.git(box.repo, 'rev-parse', 'HEAD'));
  const committedAt = new Date(box.git(box.repo, 'log', '-1', '--format=%cI', first.commit)).toISOString();
  const authoredAt = new Date(box.git(box.repo, 'log', '-1', '--format=%aI', first.commit)).toISOString();
  assert.notEqual(committedAt, authoredAt, 'the fixture distinguishes approval commit time from Git author time');
  assert.equal(first.approvedAt, committedAt, 'approval date is the actual origin commit committer date in ISO UTC');
  const need = document(box, box.repo, 'status').needs.find(entry => entry.kind === 'agent-approved' && entry.id === 'G1');
  assert.equal(need.approvedAt, committedAt, 'Needs you carries the same approval date without changing attribution');
  assert.equal(need.attribution, 'Git author, seat unknown');
  assert.deepEqual(read(), first, 'a stable origin map preserves the full attribution');
  assert.deepEqual(read(box.web), first, 'a linked worktree starts with the same historical attribution');
  writeFileSync(join(box.repo, 'SPEC.md'), '\n' + original.replace('The page renders.', 'The changed page renders.'));
  const dirty = read();
  assert.equal(dirty.commit, null, 'dirty moved lines cannot reuse the old committed attribution');
  assert.equal(dirty.approvedAt, null, 'zero-SHA blame never turns its synthetic committer time into an approval date');
  const dirtyNeed = document(box, box.repo, 'status').needs.find(entry => entry.kind === 'agent-approved' && entry.id === 'G1');
  assert.equal(dirtyNeed.approvedAt, null, 'Needs you preserves an unknown uncommitted approval date');
  assert.equal(dirty.text, 'The changed page renders.');
  writeFileSync(join(box.repo, 'SPEC.md'), original);
  box.git(box.repo, 'commit', '-q', '--amend', '--no-edit', '--author', 'Replacement Author <replacement@example.test>');
  const rewritten = read();
  assert.notEqual(rewritten.commit, first.commit, 'identical spec bytes under a new history require new origins');
  assert.equal(rewritten.agent, 'Replacement Author');
  assert.deepEqual(read(box.web), first, 'a linked worktree keeps its own unchanged revision after main moves');
  assert.deepEqual(read(), rewritten);
  document(box, box.repo, 'spec', 'approve', 'G1');
  assert.equal(read(), undefined, 'a person decision is re-evaluated independently of cached Git origins');
});


test('attribution signatures bypass namespaced refs and external blame configuration [S1,N26,C7]', t => {
  for (const [name, value] of [['GIT_CONFIG_GLOBAL', '/dev/null'], ['GIT_CONFIG_NOSYSTEM', '1']]) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const signature = () => gitReadSignature(box.repo, ['SPEC.md', '.mailmap'], { attribution: true });
  assert.match(signature(), /^[a-f0-9]{64}$/u);
  const previousNamespace = process.env.GIT_NAMESPACE;
  try {
    process.env.GIT_NAMESPACE = 'private-attribution-fixture';
    assert.equal(signature(), null, 'namespaced refs need a real Git read');
  } finally {
    if (previousNamespace === undefined) delete process.env.GIT_NAMESPACE;
    else process.env.GIT_NAMESPACE = previousNamespace;
  }
  const beforeAttributes = signature();
  writeFileSync(join(box.repo, '.gitattributes'), 'SPEC.md ident\n');
  assert.notEqual(signature(), beforeAttributes, 'working-tree conversion attributes invalidate cached origins');
  const beforeMailmap = signature();
  writeFileSync(join(box.repo, '.mailmap'), 'Other Name <other@example.test> <agent@example.com>\n');
  assert.notEqual(signature(), beforeMailmap, 'mailmap contents belong to the attribution signature');
  box.git(box.repo, 'config', 'blame.ignoreRevsFile', join(box.dir, 'external-ignore-list'));
  assert.equal(signature(), null, 'external revision lists are unsupported rather than cached incompletely');
});

test('show reads the origins of only the rows its item cites, the same origins status gives them [C7,S1]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const needs = document(box, box.repo, 'status').needs.filter(need => need.kind === 'agent-approved');
  assert.ok(needs.some(need => need.id === 'G1') && needs.some(need => need.id !== 'G1'), JSON.stringify(needs.map(need => need.id)));
  const id = document(box, box.repo, 'add', 'web', 'Cites one unconfirmed row', '--specs', 'G1', '--criterion', 'A real fixture.').item.item_id;
  const shown = document(box, box.repo, 'show', String(id));
  assert.deepEqual(shown.agentApproved.map(row => row.id), ['G1'], 'only the cited row is in the item view');
  const status = needs.find(need => need.id === 'G1');
  assert.equal(shown.agentApproved[0].commit, status.commit, 'the cited row keeps the Git origin the whole view gives it');
  assert.equal(shown.agentApproved[0].agent, status.agent);
});
