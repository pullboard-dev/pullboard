/** Lander v2 L1: a red is charged to main, rerun once then quarantined, or returned with its item; never a trunk hold [C7,#5862]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeRed } from '../../../src/io/step/judge.js';
import { QUARANTINE_MS } from '../../../src/logic/judge.js';

// The 11 Nov 8:19 pm CT batch (#5815 + #5763): its combined run failed these 8 files and filed #5830-#5837 as trunk holds.
const MAIN_RED = ['packages/gate/tests/io/check/scripts/baseline/failover.test.js', 'packages/gate/tests/logic/wait.test.js',
  'packages/gate/tests/add-check-baseline-runner.test.js', 'packages/gate/tests/io/edges/checks.test.js'];
const FLAKY = ['packages/gate/tests/io/requeue/retry.test.js', 'packages/gate/tests/slots.test.js',
  'packages/landing/tests/io/main/audit/runner.test.js', 'packages/landing/tests/io/prune.test.js'];
const NOW = new Date('2026-11-12T02:19:44.710Z');

/** A landing state whose batch writes and board moves are recorded, so a test defect or a hold would show. */
function landingState() {
  const writes = [];
  const state = { batch: { id: 'b-0819', base: 'a'.repeat(40), root: '/nowhere', items: [{ id: 5815 }, { id: 5763 }], revision: 0 },
    board: { clock: { now: () => NOW } }, gates: new Map(), say: () => {},
    write: async (operation, [args]) => { writes.push(operation); return { ...args.batch, revision: args.revision + 1 }; } };
  return { state, writes };
}

/** A complete red gate failing one case in each named file. */
function redGate(files, tree = 't-both') {
  return { tree, isGreen: false, complete: true, logPath: '/x.log', failures: files.map(file => ({ file, name: `case in ${file}` })) };
}

/** Judge ports for the replay: main fails the MAIN_RED files, the FLAKY files pass their rerun, repair items #5830 on. */
function replayPorts({ greenOnRerun = FLAKY, open = [] } = {}) {
  const reruns = [];
  return { reruns, ports: {
    save: async (state, patch) => { Object.assign(state.batch, patch); },
    testHash: (_root, file) => `hash:${file}`,
    completeGate: gate => gate.complete,
    split: async (_state, failures) => ({ known: failures.filter(f => MAIN_RED.includes(f.file)), own: failures.filter(f => !MAIN_RED.includes(f.file)) }),
    rerun: async (_state, failures) => { reruns.push(...failures.map(f => f.file)); return failures.map(f => f.file).filter(file => greenOnRerun.includes(file)); },
    repair: async (_state, failures) => [...new Set(failures.map(f => f.file))].map((test, index) => ({ test, item: 5830 + index })),
    batches: () => open.map(file => ({ quarantine: [{ file, expiresAt: new Date(NOW.getTime() + 1000).toISOString() }] })),
  } };
}

test('landing.judge.replaying-the-8-19-pm-batch: clause 1: replaying the 8:19 pm batch lands #5815 and #5763 with 4 main charges, 4 quarantine records and no LAND_TEST_DEFECT [C7,#5862]', async () => {
  const { state, writes } = landingState();
  const { ports, reruns } = replayPorts();
  const judged = await judgeRed(state, redGate([...MAIN_RED, ...FLAKY]), ports);
  assert.equal(judged.gate.isGreen, false, 'the red composition carries a proof instead of a hold');
  assert.deepEqual(judged.red, [], 'nothing is left red, so both items land');
  assert.deepEqual(state.batch.knownMain.map(row => row.file), MAIN_RED, '4 main charges');
  assert.deepEqual(state.batch.quarantine.map(row => row.file), FLAKY, '4 quarantine records');
  assert.deepEqual(reruns, FLAKY, 'only the files main does not fail rerun, once each');
  for (const record of state.batch.quarantine) {
    assert.equal(Date.parse(record.expiresAt) - NOW.getTime(), QUARANTINE_MS, 'each record expires in 48 h');
    assert.ok(Number.isSafeInteger(record.repair), 'each record names its repair item');
  }
  assert.ok(judged.gate.knownMainProof, 'the red composition carries a proof, so it publishes like a green one');
  assert.ok(!writes.includes('recordLandingTestDefect'), 'no test defect is filed');
  assert.notEqual(state.batch.state, 'test-defect', 'the trunk is not held');
});

test('landing.judge.a-file-red-on-its-rerun: a file red on its rerun is not quarantined: the composition stays red and carries its twice-red cases to its item [C7,#5862]', async () => {
  const { state } = landingState();
  const { ports } = replayPorts({ greenOnRerun: FLAKY.slice(1) });
  const judged = await judgeRed(state, redGate([...MAIN_RED, ...FLAKY]), ports);
  assert.equal(judged.gate, null);
  assert.deepEqual(judged.red.map(row => row.file), [FLAKY[0]], 'only the twice-red file goes back with the item');
  assert.equal(state.batch.quarantine, undefined, 'nothing is quarantined while a red remains');
});

test('landing.judge.a-second-flake-of-a-file: a second flake of a file inside its 48 h quarantine window is the item\'s red, not another quarantine [C7,#5862]', async () => {
  const { state } = landingState();
  const { ports } = replayPorts({ open: [FLAKY[0]] });
  const judged = await judgeRed(state, redGate(FLAKY), ports);
  assert.equal(judged.gate, null);
  assert.deepEqual(judged.red.map(row => row.file), [FLAKY[0]]);
});
