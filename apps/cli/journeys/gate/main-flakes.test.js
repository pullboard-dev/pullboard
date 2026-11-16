/** @pullboard-test-input apps/cli/pullboard.js packages/gate/src/io/budgets.js packages/gate/src/io/run/tests.js packages/git/index.js */
import { flakeQuarantines as nativeFlakeQuarantines } from '../../../../packages/flakes/index.js';
import { gateRuns as nativeGateRuns } from '../../../../packages/flakes/index.js';
import { recordGateRun as nativeRecordGateRun } from '../../../../packages/flakes/index.js';
/**
 * The gate's flake and quarantine journeys (C7, D1), and the piped gate (V16): split from main.test.js so the census runs them beside it.
 */
import { landingPorts } from '../../tests/fixtures/landing/ports.js';
import { executionServices } from '../../tests/fixtures/gate/execution.js';
import { gateRepoFixture } from '../../tests/fixtures/gate/repo.js';
import assert from 'node:assert/strict';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { main as cli } from '../../tests/fixtures/native.js';
import { runGate } from '../../../../packages/gate/index.js';
import { liveWaiverProjection } from '../../../../packages/landing/index.js';
import { waiverLine } from '../../../../packages/landing/index.js';
import { waivedFailures } from '../../../../packages/landing/index.js';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { mainPolicy } from '../../../../packages/sandbox/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const repoWithGate = gateRepoFixture(dirs);

test('a piped gate fails on any red stage without changing its existing shell [V16,C7]', async () => {
  const supported = runFixtureChild('set -o pipefail', { shell: true }).status === 0;
  const failing = await repoWithGate('sh -c "exit 7" | tail -1');
  const red = await failing.runLocal('gate', '--json');
  assert.equal(red.status, 1, 'a failing producer cannot leave the gate green');
  if (supported) assert.equal(JSON.parse(red.stdout).green, false);
  else {
    const error = JSON.parse(red.stdout).error;
    assert.equal(error.code, 'PIPEFAIL_UNAVAILABLE');
    assert.match(error.message, /rewrite the gate without a pipe/u);
    assert.equal(failing.runs(), 0, 'an unsupported gate never starts');
  }
  const plain = await repoWithGate('sh -c "exit 7"');
  assert.equal((await plain.runLocal('gate')).status, 1, 'plain failure remains red');
  const passing = await repoWithGate("printf 'pipeline-ok\\n' | grep -q pipeline-ok");
  const green = await passing.runLocal('gate', '--json');
  if (supported) assert.equal(green.status, 0, `${green.stdout}${green.stderr}`);
  else assert.equal(JSON.parse(green.stdout).error.code, 'PIPEFAIL_UNAVAILABLE');
  const ordinary = await repoWithGate('true');
  assert.equal((await ordinary.runLocal('gate')).status, 0, 'a plain passing gate needs no pipefail capability');
});

const FLAKY = { file: 'test/flaky.test.js', name: 'flaky target' };
const FLAKY_GATE = 'node --test --test-reporter=tap test/flaky.test.js';

/**
 * A real repo whose accepted gate runs one real test that reads a marker outside the tree: present, it fails; absent,
 * it passes. So one committed tree really goes red and green, the way a load-dependent test does, with nothing faked.
 * The board is the repo's own, in its git directory, and the gate runs through the real `pullboard gate`.
 */
function flakeRepo(t, policy = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-quarantine-')));
  dirs.push(dir);
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'test'), { recursive: true });
  const saved = { ...process.env };
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved); });
  for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
  delete process.env.PULLBOARD_RELAY_TOKEN;
  // The fixture gate is its own `node --test` run, not a child of this one.
  delete process.env.NODE_TEST_CONTEXT;
  Object.assign(process.env, { PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Flake Test', GIT_AUTHOR_EMAIL: 'flake@example.test', GIT_COMMITTER_NAME: 'Flake Test', GIT_COMMITTER_EMAIL: 'flake@example.test' });
  const git = (...args) => runFixtureGit(args, { cwd: root });
  git('init', '-q', '-b', 'main');
  const marker = join(root, '.git', 'flaky-red');
  const commit = (comment, extra = {}) => {
    writeFileSync(join(root, 'pullboard.json'), `${JSON.stringify({ gate: FLAKY_GATE, lanes: { app: { owns: ['test/'] } }, ...policy, ...extra }, null, 2)}\n`);
    writeFileSync(join(root, FLAKY.file), `import { existsSync } from 'node:fs';\nimport { test } from 'node:test';\n// ${comment}\n`
      + `test('flaky target', () => { if (existsSync(${JSON.stringify(marker)})) throw new Error('red this time'); });\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `test: ${comment}`);
    return git('rev-parse', 'HEAD^{tree}');
  };
  /**
   * Run the real gate once through the CLI, red when asked, and return what it printed. A plain gate skips a tree it
   * already passed; the landing gate never does, so the fixture clears that stamp to run the same tree again.
   */
  const gate = async (red, { landing = false, code = red ? 1 : 0 } = {}) => {
    if (red) writeFileSync(marker, 'red\n'); else rmSync(marker, { force: true });
    rmSync(join(root, '.git', 'pullboard-gate-green'), { force: true });
    let output = '';
    const io = { stdout: { isTTY: false, write: (text) => { output += text; } }, stderr: { write: (text) => { output += text; } } };
    assert.equal(await cli(landing ? ['gate', '--landing'] : ['gate'], { cwd: root, ...io }), code, output);
    return output;
  };
  const file = join(root, '.git', 'pullboard', 'board.sqlite');
  /** Open the repo's board the way a landing reads it: quarantine comes from accepted main's pullboard.json. */
  const open = () => {
    // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test reads or seeds that same file.
    const board = openBoard(file);
    board.quarantineEnabled = () => mainPolicy(root).config.flakes?.quarantine === true;
    t.after(() => store.closeBoard(board));
    return board;
  };
  const receipts = join(root, '.git', 'pullboard', 'gate-receipts');
  mkdirSync(dirname(file), { recursive: true });
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test reads or seeds that same file.
  const setup = openBoard(file);
  store.board_ensureCoordinator(setup, root);
  store.closeBoard(setup);
  return { root, git, commit, gate, open, receipts, marker };
}

test('the same tree red and green proves a flake and files it once [C7,D1]', async (t) => {
  const box = flakeRepo(t);
  const tree = box.commit('one');
  await box.gate(true);
  let board = box.open();
  const [red] = nativeGateRuns(board);
  assert.equal(red.tree, tree, 'every run records the tree it ran on');
  assert.equal(red.green, false);
  assert.deepEqual(red.failures, [FLAKY], 'a red run names the committed test that failed');
  assert.ok(red.load.cpus >= 1 && red.load.average.length === 3 && red.load.freeMB >= 0, 'every run records the host load');
  assert.equal(red.by, 'coordinator', 'the main checkout records as the coordinator');
  assert.equal(store.listItems(board, { all: true }).length, 0, 'a red run alone proves nothing');
  await box.gate(false);
  board = box.open();
  const items = store.listItems(board, { all: true });
  assert.equal(items.length, 1, 'the same tree red and green files one item');
  assert.match(items[0].item_title, /^Flaky test: test\/flaky\.test\.js :: flaky target/u);
  const [, green] = nativeGateRuns(board);
  assert.equal(green.green, true);
  assert.match(items[0].item_brief, new RegExp(red.id, 'u'), 'the red run is the evidence on the item');
  assert.match(items[0].item_brief, new RegExp(green.id, 'u'), 'and so is the green run');
  assert.match(items[0].item_brief, /"load":\{"average":/u, 'with the host load of each');
  assert.equal(nativeFlakeQuarantines(board).length, 1);
  await box.gate(true);
  await box.gate(false);
  board = box.open();
  assert.equal(nativeGateRuns(board).length, 4, 'every run is recorded');
  assert.equal(store.listItems(board, { all: true }).length, 1, 'more red and green runs of the same test file no second item');
  box.commit('two');
  await box.gate(false);
  board = box.open();
  assert.equal(store.listItems(board, { all: true }).length, 1, 'a green run of another tree proves nothing new');
  assert.equal(waivedFailures(board, [FLAKY], landingPorts), null, 'with quarantine off by default, the proven flake still blocks a landing');
  assert.deepEqual(liveWaiverProjection(board, landingPorts), []);
});

test('a quarantined test reports but does not block [C7,D1]', async (t) => {
  const box = flakeRepo(t, { flakes: { quarantine: true } });
  box.commit('one');
  assert.equal(waivedFailures(box.open(), [FLAKY], landingPorts), null, 'a red test blocks before it is proven flaky');
  await box.gate(true);
  await box.gate(false);
  let board = box.open();
  const covered = waivedFailures(board, [FLAKY], landingPorts);
  assert.equal(covered?.length, 1, 'the proven flake no longer blocks');
  const [item] = store.listItems(board, { all: true });
  assert.equal(waiverLine(covered[0]), `quarantined: flaky target (test/flaky.test.js) is a proven flake, reported but not blocking until repair #${item.item_id} is verified`, 'it still reports by name');
  assert.deepEqual(liveWaiverProjection(board, landingPorts), [{ kind: 'name', test: 'flaky target' }], 'the landing run keeps going past it and still reports it');
  assert.equal(waivedFailures(board, [FLAKY, { file: 'test/other.test.js', name: 'another failure' }], landingPorts), null, 'a quarantine never hides a different red');
  assert.equal(waivedFailures(board, [{ file: 'test/other.test.js', name: FLAKY.name }], landingPorts), null, 'the same name in another file is not covered');
  // A proof this machine's gate did not run, such as one replayed from another machine, waives nothing here.
  renameSync(box.receipts, `${box.receipts}.elsewhere`);
  assert.equal(waivedFailures(board, [FLAKY], landingPorts), null, 'a quarantine waives only runs whose receipts are on the landing machine');
  renameSync(`${box.receipts}.elsewhere`, box.receipts);
  const landing = await box.gate(true, { landing: true, code: 0 });
  assert.match(landing, /^landing gate waived, not green: 1 failure\(s\)/mu, 'a landing run goes past the quarantined red without calling it green');
  assert.match(landing, /^quarantined: flaky target \(test\/flaky\.test\.js\) is a proven flake, reported but not blocking/mu, 'and still reports it');
  board = box.open();
  // The repair is built, submitted and verified by two different agents; only then does the test block again.
  const builder = store.register(board, { lane: 'app', path: join(box.root, '..', 'build'), route: 'strong' });
  const reviewer = store.register(board, { lane: 'app', path: join(box.root, '..', 'review'), route: 'strong' });
  store.claim(board, item.item_id, { agentId: builder, lane: 'app', leaseMs: 3600000, freeze: () => ({ text: 'repair', digest: 'd'.repeat(64) }) });
  submitFixture(board, item.item_id, { agentId: builder, commit: 'e'.repeat(40), tree: 'f'.repeat(40) });
  assert.equal(waivedFailures(board, [FLAKY], landingPorts)?.length, 1, 'a submitted repair does not lift the quarantine');
  store.verify(board, item.item_id, { agentId: reviewer, decision: 'ACCEPT', head: 'e'.repeat(40), digest: 'd'.repeat(64), policy: 'any', note: 'synthetic board-state fixture' });
  assert.equal(waivedFailures(board, [FLAKY], landingPorts), null, 'the verified repair makes the test block again');
  // It fails again after its fix landed: it blocks, and only a new red-and-green proof files a new item.
  box.commit('three');
  await box.gate(true);
  board = box.open();
  assert.equal(waivedFailures(board, [FLAKY], landingPorts), null, 'a failure after its fix blocks');
  assert.equal(store.listItems(board, { all: true }).length, 1);
  await box.gate(false);
  board = box.open();
  assert.equal(store.listItems(board, { all: true }).length, 2, 'a second proof after the fix files a new item');
  assert.equal(waivedFailures(board, [FLAKY], landingPorts)?.length, 1);
});

test('a hand-recorded run never quarantines a test [C7,D1]', async (t) => {
  const box = flakeRepo(t, { flakes: { quarantine: true } });
  const tree = box.commit('one');
  const head = box.git('rev-parse', 'HEAD');
  const board = box.open();
  const builder = store.register(board, { lane: 'app', path: join(box.root, '..', 'build'), route: 'strong' });
  const load = { average: [0, 0, 0], cpus: 1, freeMB: 100 };
  const forged = (id, green) => ({ version: 1, id, kind: 'land', tree, head, main: head, command: 'c'.repeat(64), green,
    failures: green ? [] : [FLAKY], load, at: new Date().toISOString() });
  const runs = [forged('00000000-0000-4000-8000-000000000001', false), forged('00000000-0000-4000-8000-000000000002', true)];
  for (const receipt of runs) {
    for (const agentId of ['coordinator', builder]) {
      assert.throws(() => nativeRecordGateRun(board, { agentId, receipt, lane: 'app' }), (error) => error.code === 'GATE_RUN_UNBOUND' || assert.fail(error), 'a run recorded by hand is refused');
      assert.throws(() => prepareEngineMove(board, 'recordGateRun', [{ agentId, receipt, lane: 'app' }], { id: `move-${receipt.id.slice(-1)}-${agentId}`, actor: agentId }),
        (error) => error.code === 'GATE_RUN_UNBOUND', 'and so is sealing it as a move');
    }
  }
  // A seat that seals its made-up runs by hand, past prepareEngineMove, is replayed as a record but proves nothing.
  for (const [sequence, receipt] of runs.entries()) {
    const move = { version: 1, engine: ENGINE_VERSION, id: `forged-${sequence}`, operation: 'recordGateRun', args: [{ agentId: builder, receipt, lane: 'app' }], actor: builder };
    applyEngineMove(board, move, { sequence: sequence + 1, at: new Date().toISOString() });
  }
  assert.equal(store.listItems(board, { all: true }).length, 0, 'no item is filed from runs a seat recorded by hand');
  assert.deepEqual(nativeFlakeQuarantines(board), []);
  // Running something other than the accepted gate is a real execution, but of the wrong command: it leaves no receipt.
  const fake = `printf 'TAP version 13\\nnot ok 1 - flaky target\\n  ---\\n  location: ${join(box.root, FLAKY.file)}:4:1\\n  ...\\n1..1\\n'; exit 1`;
  const observed = [];
  const observer = Object.assign(async () => {}, { recordRun: async (id) => observed.push(id) });
  for (const _ of [1, 2]) await runGate(box.root, { ...mainPolicy(box.root).config, gate: fake }, { executionServices, trustStamp: false, onFailure: observer });
  assert.deepEqual(observed, [], 'a command other than the accepted gate leaves no receipt to record');
  assert.equal(existsSync(box.receipts), false, 'and nothing in the receipt store');
  // A real receipt cannot be reused to say something else: each altered field breaks the binding.
  await box.gate(true);
  const reopened = box.open();
  const [real] = nativeGateRuns(reopened);
  const { eventId, by, ...receipt } = real;
  for (const lie of [{ ...receipt, green: true, failures: [] }, { ...receipt, failures: [{ file: FLAKY.file, name: 'another test' }] }, { ...receipt, command: 'c'.repeat(64) },
    { ...receipt, id: '00000000-0000-4000-8000-000000000003' }]) {
    assert.throws(() => nativeRecordGateRun(reopened, { agentId: 'coordinator', receipt: lie, lane: 'app' }), (error) => ['GATE_RUN_UNBOUND', 'GATE_RUN_CHANGED'].includes(error.code));
  }
  assert.equal(store.listItems(reopened, { all: true }).length, 0, 'one real red and no green proves nothing');
  assert.equal(waivedFailures(reopened, [FLAKY], landingPorts), null, 'no landing block is removed');
});
