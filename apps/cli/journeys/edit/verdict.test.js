/** Machine acceptance uses real Git, SQLite, private checks and the ordinary landing engine [V1,V4,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { waitForCondition } from '../../tests/fixtures/runner/holders.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { machineClauseCommands } from '../../../../packages/verify/index.js';
import { machineProofProblem } from '../../../../packages/verify/index.js';
import { minimumMoveEngine } from '../../../../packages/moves/index.js';
import {
  prepareEngineMove,
  applyRelayMove,
} from '../../../../packages/state/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import * as store from '../../../../packages/store/index.js';
import { MACHINE_VERDICT_ENGINE } from '../../../../packages/state/light.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

/** Keep failures visible without interpreting a nonzero CLI result as a successful board read. */
async function json(box, root, ...args) {
  const result = await box.runLocal(root, ...args, '--json');
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

/** An expected refusal, answered by the production dispatcher in this process with the box's environment. */
async function refusal(box, cwd, ...args) {
  const result = await runCliInProcess(args, { cwd, env: box.env });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** Author a coordinator-approved bar before claiming and committing the builder's small change. */
async function fixture(t, { failing = false, sensitive = false, strict = false, advanceMain = false } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }));
  const config = { ...helpers.CONFIG, gate: 'true', landing: { publish: 'separate', manualOverride: false } };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure machine fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const item = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Machine fixture', criterion: '1. the result exists [command]\n2. the result is built [command]', check: 'test -f web/result.txt',
    brief: 'Files: web/result.txt\nTest: the result file exists and says built\n', args: ['--specs', 'G1', ...(sensitive ? ['--sensitive'] : [])], run: box.runLocal });
  const id = item.item_id;
  const commands = [{ clause: 1, command: 'test -f web/result.txt' },
    { clause: 2, command: failing ? 'test -f web/missing.txt' : 'test "$(cat web/result.txt)" = built' }];
  const path = join(box.dir, 'machine-commands.json');
  writeFileSync(path, JSON.stringify(commands));
  await json(box, box.repo, 'edit', String(id), '--machine-verified', 'on', '--machine-commands-file', path, '--reason', 'Every clause has an executable check', ...(strict ? ['--review-tier', 'strict'] : []));
  if (sensitive || strict) assert.equal((await json(box, box.repo, 'show', String(id))).reviewEligibility.tier, 'strict', 'the negative control is actually strict before building');
  await json(box, box.web, 'claim', String(id));
  if (advanceMain) {
    mkdirSync(join(box.repo, 'docs'), { recursive: true });
    writeFileSync(join(box.repo, 'docs/accepted.txt'), 'a disjoint accepted change\n');
    box.git(box.repo, 'add', 'docs/accepted.txt');
    box.git(box.repo, 'commit', '-q', '-m', 'docs: advance accepted fixture main');
  }
  assert.equal(helpers.commitFile(box, box.web, 'web/result.txt', 'built\n', 'feat(web): build result [G1]').status, 0);
  for (const entry of commands) {
    const ticked = await box.runLocal(box.web, 'fact', String(id), 'note', `clause ${entry.clause} [command]: ${entry.command} exits 0`);
    assert.equal(ticked.code, 0, ticked.out + ticked.err);
  }
  return { box, id, path, commands };
}

test('machine-verified all-green clauses land with command receipts and no reviewer [V1,V4,H16]', async t => {
  const { box, id, commands } = await fixture(t, { advanceMain: true });
  const uncomposed = box.git(box.web, 'rev-parse', 'HEAD');
  const acceptedMain = box.git(box.repo, 'rev-parse', 'main');
  const submitted = await box.runLocal(box.web, 'submit', String(id), '--no-next');
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  // Automatic landing may run in the board's worker after submit returns, so wait for it instead of reading once.
  await waitForCondition(() => onBoard(box, board => Boolean(store.getItem(board, id).item_merged_commit)), 'the board lands the machine-verified item',
    { signal: AbortSignal.timeout(120_000), state: () => ({ submitted: submitted.out + submitted.err }) });
  const shown = await json(box, box.repo, 'show', String(id));
  assert.equal(shown.item_status, 'verified');
  assert.notEqual(shown.item_commit, uncomposed, 'machine proof is for an actual composed merge, not the old builder head');
  const parents = box.git(box.web, 'rev-list', '--parents', '-n', '1', shown.item_commit).split(' ');
  assert.deepEqual(parents.slice(1).sort(), [uncomposed, acceptedMain].sort(), 'the proved commit includes builder and accepted main');
  assert.ok(shown.item_merged_commit, 'ordinary board landing records the composed commit');
  assert.equal(shown.machineVerification.enabled, true);
  const verdict = shown.thread.find(entry => entry.type === 'move' && entry.kind === 'accept');
  assert.ok(verdict, JSON.stringify(shown.thread));
  assert.equal(verdict.detail.review.commit, shown.item_commit);
  assert.equal(verdict.detail.review.trunk, acceptedMain);
  assert.equal(shown.verdicts.length, 1, 'there is one machine verdict, with no model review');
  assert.match(shown.verdicts[0].verdict_note, /machine-verified/u);
  for (const entry of commands) assert.ok(shown.verdicts[0].verdict_note.includes(entry.command));
  const receipts = shown.proofReceipts.filter(receipt => receipt.commit === shown.item_commit && receipt.exitCode === 0);
  assert.ok(receipts.length >= commands.length + 1, 'frozen proof and both clauses have native receipts');
  assert.equal(readFileSync(join(box.repo, 'web/result.txt'), 'utf8'), 'built\n');
});

test('machine verification refuses a failing clause by number without publishing a verdict [V1,V4,H16]', async t => {
  const { box, id } = await fixture(t, { failing: true });
  const result = await refusal(box, box.web, 'submit', String(id), '--no-next');
  assert.notEqual(result.code, 0);
  assert.match(result.out + result.err, /MACHINE_CLAUSE_RED.*clause 2/u);
  const shown = await json(box, box.repo, 'show', String(id));
  assert.equal(shown.item_status, 'claimed');
  assert.equal(shown.verdicts.length, 0);
  assert.equal(shown.item_merged_commit, null);
});

test('sensitive and strict machine-marked work remains submitted for an independent reviewer [V1,V4,H16]', async t => {
  for (const policy of [{ sensitive: true }, { strict: true }]) {
    const { box, id } = await fixture(t, policy);
    const result = await box.runLocal(box.web, 'submit', String(id), '--no-next');
    assert.equal(result.code, 0, result.out + result.err);
    const shown = await json(box, box.repo, 'show', String(id));
    assert.equal(shown.item_status, 'submitted', JSON.stringify(policy));
    assert.equal(shown.verdicts.length, 0);
    assert.equal(shown.item_merged_commit, null);
  }
});

test('machine authorization is coordinator-only, visible, reversible and off by default [V1,V4,H16]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const id = (await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Opt-in fixture', criterion: '1. one [command]\n2. two [command]', check: 'true',
    brief: 'Files: web/result.txt\nTest: the result file exists and says built\n', run: box.runLocal })).item_id;
  assert.equal((await json(box, box.repo, 'show', String(id))).machineVerification, null);
  const path = join(box.dir, 'commands.json');
  writeFileSync(path, JSON.stringify([{ clause: 1, command: 'true' }, { clause: 2, command: 'true' }]));
  const denied = await refusal(box, box.web, 'edit', String(id), '--machine-verified', 'on', '--machine-commands-file', path);
  assert.notEqual(denied.code, 0);
  assert.match(denied.out + denied.err, /COORDINATOR_ONLY/u);
  await json(box, box.repo, 'edit', String(id), '--machine-verified', 'on', '--machine-commands-file', path, '--reason', 'Machine bar');
  assert.equal((await json(box, box.repo, 'show', String(id))).machineVerification.enabled, true);
  await json(box, box.repo, 'edit', String(id), '--machine-verified', 'off', '--reason', 'Restore human judgment');
  assert.equal((await json(box, box.repo, 'show', String(id))).machineVerification, null);
});

test('machine clauses reject judgment, missing commands and duplicate coverage [V1,V4,H16]', () => {
  const item = { item_criterion: '1. one [command]\n2. two [command]' };
  assert.throws(() => machineClauseCommands(item, [{ clause: 1, command: 'true' }, { clause: 1, command: 'true' }]), { code: 'MACHINE_COMMANDS' });
  assert.throws(() => machineClauseCommands(item, []), { code: 'MACHINE_COMMANDS' });
  assert.throws(() => machineClauseCommands({ item_criterion: '1. one [command]\n2. clear [reasoning]' }, []), { code: 'MACHINE_JUDGMENT' });
  const problem = machineProofProblem({ item_id: 1 }, { commands: [] }, [], { frozenCheck: 'true' });
  assert.equal(problem.code, 'MACHINE_PROOF');
});


test('machine receipts bind commands, source, main, digest and seat with raw green exits [V1,V4,H16]', () => {
  const item = { item_id: 1, item_frozen_digest: 'a'.repeat(64) };
  const authorization = { commands: [{ clause: 1, command: 'test -f result' }] };
  const source = { commit: 'b'.repeat(40), tree: 'c'.repeat(40), main: 'd'.repeat(40), seat: 'web-1', frozenCheck: 'true' };
  const receipts = ['true', 'test -f result'].map((command, index) => ({ version: 2, id: String(index), green: true,
    head: source.commit, tree: source.tree, main: source.main, command: createHash('sha256').update(command).digest('hex'),
    proof: { item: 1, frozenDigest: item.item_frozen_digest, seat: source.seat, exitCode: 0, sourceClean: true, environment: null } }));
  assert.equal(machineProofProblem(item, authorization, receipts, source), null, 'plain shell commands retain an explicitly unknown Node environment');
  for (const patch of [{ head: 'e'.repeat(40) }, { tree: 'e'.repeat(40) }, { main: 'e'.repeat(40) }, { command: 'e'.repeat(64) }, { green: false }]) {
    const changed = [receipts[0], { ...receipts[1], ...patch }];
    assert.match(machineProofProblem(item, authorization, changed, source).message, /clause 1/u);
  }
  for (const patch of [{ seat: 'web-2' }, { frozenDigest: 'e'.repeat(64) }, { item: 2 }, { sourceClean: false }, { exitCode: 1 }]) {
    const changed = [receipts[0], { ...receipts[1], proof: { ...receipts[1].proof, ...patch } }];
    assert.match(machineProofProblem(item, authorization, changed, source).message, /clause 1/u);
  }
  assert.equal(machineProofProblem(item, authorization, [receipts[0], { ...receipts[1], id: receipts[0].id }], source).code, 'MACHINE_PROOF');
});


test('machine commands alone retain their replay engine floor without changing legacy edits [C7,H16]', async t => {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/fixture' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Machine replay fixture' });
  const fields = { agentId: 'coordinator', machineCommands: [{ clause: 1, command: 'true' }] };
  assert.equal(minimumMoveEngine('editItem', [id, fields], board), MACHINE_VERDICT_ENGINE,
    'a commands-only payload cannot be interpreted by a replica predating machine authorization');
  const move = prepareEngineMove(board, 'editItem', [id, fields], { id: 'machine-commands-only', actor: 'coordinator' });
  const before = exportBoard(board);
  const receipt = { sequence: 1, at: '2026-11-02T00:00:00Z', kind: 'move',
    sender: { kind: 'agent', userId: 'fixture', agent: 'coordinator' } };
  assert.throws(() => applyRelayMove(board, { ...move, engine: MACHINE_VERDICT_ENGINE - 1 }, receipt),
    error => error.code === 'RELAY_MOVE' && /introduced in engine/u.test(error.message));
  assert.deepEqual(exportBoard(board), before, 'old-engine refusal cannot change rows or the replay cursor');
  const ordinary = prepareEngineMove(board, 'editItem', [id, { agentId: 'coordinator', brief: 'Ordinary historical edit' }],
    { id: 'ordinary-edit', actor: 'coordinator' });
  assert.equal(minimumMoveEngine('editItem', ordinary.args, board), 1);
  const result = applyRelayMove(board, { ...ordinary, engine: 1 }, receipt);
  assert.equal(result.error, undefined);
  assert.equal(store.getItem(board, id).item_brief, 'Ordinary historical edit');
});
