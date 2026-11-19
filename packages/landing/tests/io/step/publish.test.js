/** A refused flake ratchet ends the landing as a recorded block, so a restart never gates the batch again [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';
import { requireSprintProof } from '../../../src/io/step/publish.js';
import { save } from '../../../src/io/step/merge.js';
import { validateLandingBatch } from '../../../../items/index.js';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { prepareFlakeLanding } from '../../../src/io/step/publish.js';
import * as store from '../../../../store/index.js';
import { flakeRatchetBeforeGate } from '../../../src/io/step/trunk.js';
import { flakeRatchetOrBlock } from '../../../src/io/step/trunk.js';

/** A gating batch on a real board whose ratchet port answers as the test asks. */
function gating(t, ratchet) {
  const board = cellBoard(t, ':memory:');
  cellSeat(board, { lane: 'coordinator', path: '/coordinator' });
  const said = [];
  const state = { board, say: text => said.push(text), landingPorts: { landingFlakeRatchet: () => ratchet },
    write: async (operation, args) => store[operation](board, ...args), batch: null };
  state.batch = store.recordLandingBatch(board, { agentId: 'coordinator', revision: 0, batch: { version: 1, id: 'ratchet-block', state: 'gating',
    base: 'a'.repeat(40), tip: 'b'.repeat(40), root: '/fixture', branch: 'refs/heads/main', owner: 'coordinator', logPath: '/fixture/log', items: [], candidates: [], conflicts: [] } });
  return { state, said, latest: () => store.landingBatches(board).find(batch => batch.id === 'ratchet-block') };
}

test('landing.publish.a-refused-ratchet-records-the-batch: a refused ratchet records the batch blocked with FLAKE_RATCHET and stops the landing [C7]', async t => {
  const { state, said, latest } = gating(t, { allowed: false, unprotected: [{ file: 'test/flaky.test.js', name: 'case' }], malformed: [], unjustified: [] });
  assert.equal(await flakeRatchetOrBlock(state), false);
  assert.deepEqual([latest().state, latest().refusal?.code], ['blocked', 'FLAKE_RATCHET']);
  assert.match(said.join('\n'), /nothing landed: .*test\/flaky\.test\.js :: case/);
});

test('landing.publish.an-allowed-ratchet-binds-its-snapshot: an allowed ratchet binds its snapshot and lets the landing go on [C7]', async t => {
  const snapshot = { version: 1, eventId: 0, count: 0, quarantines: [] };
  const { state, latest } = gating(t, { allowed: true, unprotected: [], malformed: [], unjustified: [], snapshot });
  assert.equal(await flakeRatchetOrBlock(state), true);
  assert.equal(latest().state, 'gating');
});

test('landing.publish.before-its-gate-a-refused-ratchet: before its gate a refused ratchet blocks the batch FLAKE_RATCHET and starts no gate [C7]', async t => {
  const { state, said, latest } = gating(t, { allowed: false, unprotected: [{ file: 'test/flaky.test.js', name: 'case' }], malformed: [], unjustified: [] });
  await assert.rejects(() => flakeRatchetBeforeGate(state), { code: 'FLAKE_RATCHET', message: /test\/flaky\.test\.js :: case/ });
  assert.deepEqual([latest().state, latest().refusal?.code], ['blocked', 'FLAKE_RATCHET']);
  assert.deepEqual(said, []);
  assert.equal(state.gates, undefined, 'no gate state was created');
});

test('landing.publish.before-its-gate-an-allowed-ratchet: before its gate an allowed ratchet changes nothing and the publish step keeps its own check [C7]', async t => {
  const { state, latest } = gating(t, { allowed: true, unprotected: [], malformed: [], unjustified: [], snapshot: { version: 1, eventId: 0, count: 0, quarantines: [] } });
  await flakeRatchetBeforeGate(state);
  assert.equal(latest().state, 'gating');
  assert.equal(latest().flakeRatchet, undefined, 'the snapshot binds later, after the gate');
  await assert.rejects(() => prepareFlakeLanding({ ...state, landingPorts: { landingFlakeRatchet: () => ({ allowed: false, unprotected: [{ file: 'a.test.js', name: 'n' }], malformed: [], unjustified: [] }) } }), { code: 'FLAKE_RATCHET' });
});

/** A one-item batch on a real repository whose staged tip has the receipt and composedEqual flag the case gives it. */
async function composedBatch(t, { composedEquality = true, composedEqual = true, receipt }) {
  const { root, put } = fixture(t);
  put('packages/alpha/src/a.js', 'export const a = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: base');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  put('packages/alpha/src/a.js', 'export const a = 2;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'feat: item 7');
  const tip = git(root, 'rev-parse', 'HEAD').trim();
  const batchRoot = `${root}-batch`;
  git(root, 'worktree', 'add', '-q', '--detach', batchRoot, tip);
  t.after(() => rmSync(batchRoot, { recursive: true, force: true }));
  const tree = git(root, 'rev-parse', `${tip}^{tree}`).trim();
  const calls = [];
  const batch = { version: 1, id: 'batch-7', state: 'gating', base, tip, root: batchRoot, branch: 'refs/heads/main', items: [], owner: 'coordinator',
    logPath: '/dev/null', conflicts: [], resolutions: [], revision: 0, exactTree: { tree, composedEqual }, proof: { tree, ...(receipt ? { receipt: receipt(tree) } : {}) } };
  const ports = {
    changedFiles: () => ['packages/alpha/src/a.js'],
    pin: () => 'tooling-pin-0123456789abcdef0123456789abcdef0123',
    runStatic: async () => { calls.push('static'); return { isGreen: true, output: '' }; },
    runCell: async cell => { calls.push(cell); return { isGreen: true, output: '' }; },
  };
  const state = { root, batch, config: { landing: { composedEquality } }, say: () => {}, checkLease: async () => {}, sprintPorts: ports,
    write: async (name, [{ batch: next, revision }]) => { validateLandingBatch(next, revision); return { ...next, revision: revision + 1 }; },
    board: { clock: { now: () => new Date('2026-11-18T20:00:00.000Z') } } };
  await save(state, { state: 'gating' });
  return { state, calls, tree };
}

test('landing.publish.composed-equality-skips-retest-same-tree: clause 1: with landing.composedEquality on, a composedEqual batch with a green receipt for the same tree runs no Sprint retest and records green, same-tree and the receipt id [C7,#10975]', async t => {
  const { state, calls, tree } = await composedBatch(t, { receipt: treeId => ({ id: 'receipt-1', tree: treeId, green: true }) });
  const record = await requireSprintProof(state);
  assert.deepEqual(calls, [], 'no static stage and no cell ran');
  assert.equal(record.result, 'green');
  assert.equal(record.composition, 'same-tree');
  assert.equal(record.receipt, 'receipt-1');
  assert.equal(record.tree, tree);
});

test('landing.publish.composed-equality-reproves-without-green-receipt: clause 2: a composedEqual batch whose receipt is red, missing or for another tree id, or whose setting is off, still runs the Sprint proof [C7,#10975]', async t => {
  const cases = [
    { receipt: treeId => ({ id: 'r', tree: treeId, green: false }) },
    { receipt: null },
    { receipt: () => ({ id: 'r', tree: 'a'.repeat(40), green: true }) },
    { receipt: treeId => ({ id: 'r', tree: treeId, green: true }), composedEquality: false },
    { receipt: treeId => ({ id: 'r', tree: treeId, green: true }), composedEqual: false },
  ];
  for (const given of cases) {
    const { state, calls } = await composedBatch(t, given);
    const record = await requireSprintProof(state);
    assert.deepEqual(calls, ['static', 'packages/alpha'], `the proof ran for ${JSON.stringify(given.receipt?.('x') ?? null)} ${given.composedEquality} ${given.composedEqual}`);
    assert.equal(record.composition, given.composedEqual === false && given.composedEquality !== false ? 're-proved' : undefined);
  }
});

test('landing.publish.composed-equality-reproves-differing-tree: clause 1: with landing.composedEquality on, requireSprintProof on a batch whose composedEqual is false runs the Sprint proof on the staged tree and records composition re-proved [C7,#10976]', async t => {
  const { state, calls, tree } = await composedBatch(t, { composedEqual: false, receipt: treeId => ({ id: 'receipt-1', tree: treeId, green: true }) });
  const record = await requireSprintProof(state);
  assert.deepEqual(calls, ['static', 'packages/alpha'], 'the proof ran on the staged tree');
  assert.equal(record.result, 'green');
  assert.equal(record.composition, 're-proved');
  assert.equal(record.tree, tree);
  assert.equal(state.batch.exactTree.composition, 're-proved', 'the saved record carries it');
});

test('landing.publish.composed-equality-off-saves-no-composition: clause 2: with landing.composedEquality off the Sprint proof runs as before and the saved exactTree carries no composition field [C7,#10976]', async t => {
  const { state, calls } = await composedBatch(t, { composedEquality: false, composedEqual: false });
  const record = await requireSprintProof(state);
  assert.deepEqual(calls, ['static', 'packages/alpha']);
  assert.equal(record.result, 'green');
  assert.equal('composition' in state.batch.exactTree, false, 'no composition field is saved');
});

test('landing.publish.parallel-group-regates-only-when-trunk-moved: clause 1: two one-item batches of one start group run exactly one Sprint proof between them, none for the batch trunk did not move under and one, recorded re-proved, for the batch staged after that one landed [C7,#9749]', async t => {
  const green = treeId => ({ id: 'receipt-1', tree: treeId, green: true });
  const first = await composedBatch(t, { composedEquality: true, composedEqual: true, receipt: green });
  const second = await composedBatch(t, { composedEquality: true, composedEqual: false, receipt: green });
  const firstRecord = await requireSprintProof(first.state);
  assert.deepEqual(first.calls, [], 'the batch whose staged tree equals its proven tree runs no Sprint retest');
  assert.equal(firstRecord.composition, 'same-tree');
  const secondRecord = await requireSprintProof(second.state);
  assert.deepEqual(second.calls, ['static', 'packages/alpha'], 'the batch staged after the first landed runs the Sprint proof once');
  assert.equal(secondRecord.composition, 're-proved');
  assert.equal([...first.calls, ...second.calls].filter(call => call === 'static').length, 1, 'one proof between the two batches');
});

/** The batch of composedBatch with a bar port that is red for item 7's file, and a write that records the reopen. */
async function reprovedRed(t, composedEquality) {
  const { state } = await composedBatch(t, { composedEquality, composedEqual: false });
  const reopens = [];
  const write = state.write;
  state.write = async (name, args) => (name === 'reopen' ? reopens.push(args) : write(name, args));
  state.config.landing.sprintBarTests = true;
  state.sprintPorts.runBar = async () => ({ isGreen: false, refused: true, output: 'not ok', file: 'packages/alpha/tests/a.test.js', item: 7, items: [{ item: 7, files: ['packages/alpha/tests/a.test.js'] }] });
  return { state, reopens };
}

test('landing.publish.reprove-red-reopens-the-item: clause 1: with landing.composedEquality on, a re-proved tree red in an item bar test leaves main where it was and reopens that item naming the file and the 12-character main-at [C7,#10776]', async t => {
  const { state, reopens } = await reprovedRed(t, true);
  await assert.rejects(() => requireSprintProof(state), { code: 'LAND_REPROVE_RED' });
  assert.equal(reopens.length, 1);
  assert.equal(reopens[0][0], 7);
  assert.match(reopens[0][1].note, /packages\/alpha\/tests\/a\.test\.js/);
  assert.ok(reopens[0][1].note.includes(`main ${state.batch.base.slice(0, 12)};`), 'main-at is the 12-character sha');
  assert.ok(!reopens[0][1].note.includes(state.batch.base), 'not the full sha');
  assert.doesNotMatch(reopens[0][1].note, /merge main/);
  assert.equal(state.batch.state, 'blocked');
});

test('landing.publish.reprove-red-setting-off-blocks: clause 2: with landing.composedEquality off a red bar test is still the LAND_EXACT_RED batch block and reopens nothing [C7,#10776]', async t => {
  const { state, reopens } = await reprovedRed(t, false);
  await assert.rejects(() => requireSprintProof(state), { code: 'LAND_EXACT_RED' });
  assert.deepEqual(reopens, []);
  assert.equal(state.batch.refusal.code, 'LAND_EXACT_RED');
});

/** A main that moved on from the item's base by one edit of `file`; returns its commit and leaves the checkout where it was. */
function moveMainOn(root, base, file) {
  const here = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'checkout', '-q', '--detach', base);
  writeFileSync(join(root, file), `export const moved = 1;\n`);
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'feat: main moves');
  const tip = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'checkout', '-q', '--detach', here);
  return tip;
}

test('landing.publish.reprove-red-keeps-verdict: clause 1: with landing.composedEquality on, the reopen on a re-proof red reads the verdict projector: the review is kept when main changed no reviewed file and named stale when it did [C7,U159,#10777]', async t => {
  for (const [file, expected] of [['packages/alpha/src/other.js', /accepted review stays bound/u], ['packages/alpha/src/a.js', /its review is stale, since main changed "packages\/alpha\/src\/a\.js"/u]]) {
    const { state, reopens } = await reprovedRed(t, true);
    const item = state.batch.tip;
    const trunk = git(state.root, 'rev-parse', `${item}~1`).trim();
    state.batch.base = moveMainOn(state.root, trunk, file);
    state.verdictReads = { events: () => [], verdictReviewProblem: () => null, trunkRef: () => 'refs/heads/main',
      acceptedVerdict: () => ({ review: { trunk, head: item, paths: ['packages/alpha/src/a.js'] } }),
      getItem: (_board, id) => ({ item_id: id, item_status: 'open', item_commit: item, item_claim_head: trunk }) };
    await assert.rejects(() => requireSprintProof(state), { code: 'LAND_REPROVE_RED' });
    assert.match(reopens[0][1].note, expected, file);
  }
});
