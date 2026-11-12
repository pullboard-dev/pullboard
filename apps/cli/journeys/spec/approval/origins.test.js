/** Hand-written approval is visible without becoming a person's decision [S1,B26,P6]. */
import { verifiedPasskeyRowDecision } from '../../../../../packages/person/index.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { configFromSource } from '../../../../../packages/config/index.js';
import { gitReadSignature } from '../../../../../packages/git/index.js';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { captureSpecApprovalBaseline } from '../../../../../packages/spec/index.js';
import { specApprovalState } from '../../../../../packages/spec/index.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { importBoard } from '../../../../../packages/store/index.js';
import { applyRelayMove } from '../../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../../packages/state/index.js';

/** Run the private project's real CLI and require its structured successful response. */
async function document(box, root, ...args) {
  const result = await box.runIn(root, ...args, '--json');
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  return JSON.parse(result.out);
}

test('a clone recognizes an exact signed approval without borrowing another board history [S19,S20,P6]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const key = join(box.dir, 'private-fixture-signing-key');
  const made = runFixtureChild('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env: box.env, encoding: 'utf8' });
  assert.equal(made.status, 0, made.failure ?? made.stderr);
  box.git(box.repo, 'config', 'user.signingkey', key);
  await document(box, box.repo, 'spec', 'signers', 'add', '--key', key + '.pub', '--by', 'fixture-person');
  const approved = await document(box, box.repo, 'spec', 'approve', 'G1', '--by', 'fixture-person');
  assert.ok(approved.decisions[0].signature, 'the fixture person produced an actual SSH signature');
  await document(box, box.repo, 'spec', 'apply');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore(spec): preserve the signed approval');
  const clone = join(box.dir, 'signed-clone');
  box.git(box.repo, 'clone', '-q', box.repo, clone);
  const cloneSpec = readFileSync(join(clone, 'SPEC.md'), 'utf8');
  writeFileSync(join(clone, 'SPEC.md'), '# Clone setup\n\n## G · Goals\n');
  await document(box, clone, 'init');
  writeFileSync(join(clone, 'SPEC.md'), cloneSpec);
  assert.equal((await document(box, clone, 'status')).needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), false,
    'a separate local board verifies the committed signed receipt');
  const view = await helpers.startView(box, clone);
  t.after(view.stop);
  const before = (await view.state(clone)).project;
  assert.equal(before.spec.find(row => row.id === 'G1').agentApproval, null);
  const head = box.git(clone, 'rev-parse', 'HEAD');
  const events = (await document(box, clone, 'export')).tables.event;
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
  assert.deepEqual((await document(box, clone, 'export')).tables.event, events, 'proof reads made no board event');
  const source = readFileSync(join(clone, 'SPEC.md'), 'utf8');
  writeFileSync(join(clone, 'SPEC.md'), source.replace('gate: web test', 'gate: web stricter-test'));
  assert.ok((await document(box, clone, 'status')).needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'),
    'a signed approval does not authorize different gate bytes');
});

test('malformed approval evidence stays unconfirmed without blocking default flag work [S1,B26,P6]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  await document(box, box.repo, 'spec', 'approve', 'G1');
  assert.equal((await document(box, box.repo, 'status')).needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), false);
  mkdirSync(join(box.repo, '.pullboard'), { recursive: true });
  await document(box, box.repo, 'spec', 'decline', 'G2', '--reason', 'Not a governing requirement');
  writeFileSync(join(box.repo, '.pullboard/signoffs.jsonl'), '{not valid JSON\n');
  const status = await document(box, box.repo, 'status');
  assert.ok(status.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), 'bad proof does not confirm even a board-held decision');
  assert.ok(status.specApprovalEvidenceErrors.some(error => error.code === 'BAD_SIGNOFFS'));
  assert.equal((await document(box, box.repo, 'status')).needs.some(need => need.kind === 'agent-approved' && need.id === 'G2'), false,
    'one person decline removes the outstanding approval call');
  const id = (await document(box, box.repo, 'add', 'web', 'Default flag remains usable', '--specs', 'G1', '--criterion', 'A real fixture.')).item.item_id;
  // The malformed ledger is in the coordinator checkout; the builder independently sees an unconfirmed row.
  assert.equal((await box.runIn(box.web, 'claim', String(id))).code, 0);
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

test('cached origins follow dirty lines and changed history while person decisions stay live [S1,B26,N26]', async t => {
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
  const need = (await document(box, box.repo, 'status')).needs.find(entry => entry.kind === 'agent-approved' && entry.id === 'G1');
  assert.equal(need.approvedAt, committedAt, 'Needs you carries the same approval date without changing attribution');
  assert.equal(need.attribution, 'Git author, seat unknown');
  assert.deepEqual(read(), first, 'a stable origin map preserves the full attribution');
  assert.deepEqual(read(box.web), first, 'a linked worktree starts with the same historical attribution');
  writeFileSync(join(box.repo, 'SPEC.md'), '\n' + original.replace('The page renders.', 'The changed page renders.'));
  const dirty = read();
  assert.equal(dirty.commit, null, 'dirty moved lines cannot reuse the old committed attribution');
  assert.equal(dirty.approvedAt, null, 'zero-SHA blame never turns its synthetic committer time into an approval date');
  const dirtyNeed = (await document(box, box.repo, 'status')).needs.find(entry => entry.kind === 'agent-approved' && entry.id === 'G1');
  assert.equal(dirtyNeed.approvedAt, null, 'Needs you preserves an unknown uncommitted approval date');
  assert.equal(dirty.text, 'The changed page renders.');
  writeFileSync(join(box.repo, 'SPEC.md'), original);
  box.git(box.repo, 'commit', '-q', '--amend', '--no-edit', '--author', 'Replacement Author <replacement@example.test>');
  const rewritten = read();
  assert.notEqual(rewritten.commit, first.commit, 'identical spec bytes under a new history require new origins');
  assert.equal(rewritten.agent, 'Replacement Author');
  assert.deepEqual(read(box.web), first, 'a linked worktree keeps its own unchanged revision after main moves');
  assert.deepEqual(read(), rewritten);
  await document(box, box.repo, 'spec', 'approve', 'G1');
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

test('show reads the origins of only the rows its item cites, the same origins status gives them [C7,S1]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const needs = (await document(box, box.repo, 'status')).needs.filter(need => need.kind === 'agent-approved');
  assert.ok(needs.some(need => need.id === 'G1') && needs.some(need => need.id !== 'G1'), JSON.stringify(needs.map(need => need.id)));
  const id = (await document(box, box.repo, 'add', 'web', 'Cites one unconfirmed row', '--specs', 'G1', '--criterion', 'A real fixture.')).item.item_id;
  const shown = await document(box, box.repo, 'show', String(id));
  assert.deepEqual(shown.agentApproved.map(row => row.id), ['G1'], 'only the cited row is in the item view');
  const status = needs.find(need => need.id === 'G1');
  assert.equal(shown.agentApproved[0].commit, status.commit, 'the cited row keeps the Git origin the whole view gives it');
  assert.equal(shown.agentApproved[0].agent, status.agent);
});
