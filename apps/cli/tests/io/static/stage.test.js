/** The gate's static stage runs locally and prints each finding with its rule code [C7,#8318]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { runStaticStage } from '../../../src/io/static/stage.js';
import { runStaticStageAdmitted } from '../../../src/io/static/stage.js';
import { staticCheckSlots } from '../../../../../packages/config/index.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { fixtureMachineSettings } from '../../fixtures/testkit.js';
import { fixtureCommittedGraph } from '../../fixtures/testkit.js';

/** A stage command that prints the given lines and exits with the given status, through the real shell. */
const printing = (lines, status) => `printf '%s\\n' ${lines.map(line => `'${line}'`).join(' ')}; exit ${status}`;

/** Run the stage with a recording output channel. */
function stage(command) {
  const said = [];
  const results = [];
  const code = runStaticStage({ say: text => said.push(text), result: row => results.push(row) }, process.cwd(), { command });
  return { code, said, results };
}

// Rows verbatim from the gate's STATIC_RED on commit 6cb326a6d9e4 (item 5841), as `pullboard gate --static` printed them there.
const RED = [
  'packages/api/tests/io/ledger.test.js:8: new test finding exceeds the ratchet: imports packages/gate/index.js, outside its own cell api',
  'packages/api/tests/io/ledger.test.js:9: new test finding exceeds the ratchet: imports packages/gate/index.js, outside its own cell api',
  'packages/api:1: cell api is no longer sealed: a test breaks a cell-test rule or a file imports past its front door',
];

test('cli.io-static-stage.the-local-static-stage-prints-each-finding: clause 1: the local static stage prints each finding with its rule code and exits 1 [C7]', () => {
  const { code, said, results } = stage(printing(RED, 1));
  assert.equal(code, 1);
  assert.deepEqual(said, RED.map(row => `STATIC_RED ${row}`));
  assert.deepEqual(results[0].findings.map(row => [row.rule, row.file, row.line]),
    [['STATIC_RED', 'packages/api/tests/io/ledger.test.js', 8], ['STATIC_RED', 'packages/api/tests/io/ledger.test.js', 9], ['STATIC_RED', 'packages/api', 1]]);
});

test('cli.io-static-stage.a-green-static-stage-exits-0-and: clause 1: a green static stage exits 0 and says the gate will not return STATIC_RED [C7]', () => {
  const { code, said } = stage(printing(['static style, prose declarations, clock budgets and doctrine hold'], 0));
  assert.equal(code, 0);
  assert.match(said.join('\n'), /static stage green/u);
});

test('cli.io-static-stage.a-commit-the-gate-judged-static-red: clause 2: a commit the gate judged STATIC_RED reports the same finding file, line and text [C7]', () => {
  const { said } = stage(printing(['Auto-merging packages/gate/data/baselines/cli-launches.json', ...RED], 1));
  assert.ok(said.includes(`STATIC_RED ${RED[2]}`));
  assert.ok(said.includes(`STATIC_RED ${RED[0]}`));
});

test('cli.io-static-stage.a-crash-that-prints-no-file-line: clause 2: a crash that prints no file:line row is still reported red with its output [C7]', () => {
  const { code, said } = stage(printing(['Error: boom'], 1));
  assert.equal(code, 1);
  assert.match(said.join('\n'), /^STATIC_RED the static stage failed with no file:line finding:\nError: boom/u);
});

/** Point machine storage at a fresh folder, with the given settings object, for one test; returns the restore. */
function isolatedMachine(settings) {
  const home = privateFixtureFiles('pullboard-static-slots-').root;
  const before = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  if (settings !== undefined) fixtureMachineSettings(home, settings);
  return () => {
    if (before === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = before;
    rmSync(home, { recursive: true, force: true });
  };
}

/** A promise with its resolver, so a test waits on an observable event instead of a timer. */
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** One static run whose stage starts, announces it, and holds until released; `said` collects its output and wake fires on STATIC_WAIT. */
function heldRun() {
  const started = deferred();
  const waiting = deferred();
  const hold = deferred();
  const said = [];
  const io = { say: text => { said.push(text); if (text.startsWith('STATIC_WAIT')) waiting.resolve(); } };
  const run = async () => { started.resolve(); await hold.promise; return 0; };
  return { said, started: started.promise, waiting: waiting.promise, release: hold.resolve, done: runStaticStageAdmitted(io, process.cwd(), { run }) };
}

test('cli.io-static-stage.a-third-concurrent-static-run-waits-for: clause 1: a third concurrent static run waits for a slot, names the wait and its place, then runs [C7,#8501]', async () => {
  const restore = isolatedMachine();
  try {
    const [first, second, third] = [heldRun(), heldRun(), heldRun()];
    await Promise.all([first.started, second.started]);
    await third.waiting;
    assert.match(third.said.join('\n'), /STATIC_WAIT static checks run 2 at a time .*you are number 1 in line/u);
    assert.deepEqual(first.said, []);
    first.release();
    await third.started;
    second.release(); third.release();
    assert.deepEqual(await Promise.all([first.done, second.done, third.done]), [0, 0, 0]);
  } finally { restore(); }
});

test('cli.io-static-stage.a-run-that-throws-gives-its-slot: clause 1: a run that throws gives its slot back [C7,#8501]', async () => {
  const restore = isolatedMachine({ gate: { staticSlots: 1 } });
  try {
    await assert.rejects(runStaticStageAdmitted({ say() {} }, process.cwd(), { run: async () => { throw new Error('boom'); } }), /boom/u);
    const next = heldRun();
    await next.started;
    next.release();
    assert.equal(await next.done, 0);
  } finally { restore(); }
});

test('cli.io-static-stage.the-static-slot-count-is-2-by: clause 2: the static slot count is 2 by default and comes from the gate.staticSlots machine setting [C7,#8501]', () => {
  let restore = isolatedMachine();
  try { assert.equal(staticCheckSlots(), 2); } finally { restore(); }
  restore = isolatedMachine({ gate: { staticSlots: 5 } });
  try { assert.equal(staticCheckSlots(), 5); } finally { restore(); }
});

/** A committed repository with main at its first commit and the item one commit ahead; returns its writer and main's commit. */
function committedItem() {
  const graph = fixtureCommittedGraph('pullboard-static-memo-');
  graph.put('a.js', 'export const a = 1;\n');
  const main = graph.commit();
  graph.put('b.js', 'export const b = 2;\n');
  graph.commit();
  return { files: { root: graph.root, write: graph.put }, main };
}

/** Run the admitted stage twice on one tree, `between` running after the first; returns how often the stage ran and what the second said. */
async function twice(settings, between = () => {}) {
  const restore = isolatedMachine(settings);
  const { files, main } = committedItem();
  try {
    let runs = 0;
    const said = [];
    const options = { command: 'true', main, run: async () => { runs += 1; return 0; } };
    assert.equal(await runStaticStageAdmitted({ say() {} }, files.root, options), 0);
    between(files);
    assert.equal(await runStaticStageAdmitted({ say: text => said.push(text) }, files.root, options), 0);
    return { runs, said: said.join('\n') };
  } finally { restore(); rmSync(files.root, { recursive: true, force: true }); }
}

test('cli.io-static-stage.with-gate-staticmemo-on-a-rerun-on: clause 1: with gate.staticMemo on, a rerun on the same clean tree and main answers green without running the stage [C7]', async () => {
  const { runs, said } = await twice({ gate: { staticMemo: true } });
  assert.equal(runs, 1);
  assert.match(said, /static stage green: kept from a green run of this exact clean tree and main/u);
});

test('cli.io-static-stage.with-gate-staticmemo-at-its-default-off: clause 2: with gate.staticMemo at its default (off), the stage runs again on the same tree [C7]', async () => {
  const { runs, said } = await twice(undefined);
  assert.equal(runs, 2);
  assert.doesNotMatch(said, /kept/u);
});

test('cli.io-static-stage.with-gate-staticmemo-on-an-uncommitted-change: clause 2: with gate.staticMemo on, an uncommitted change runs the stage again [C7]', async () => {
  const { runs } = await twice({ gate: { staticMemo: true } }, files => files.write('b.js', 'export const b = 3;\n'));
  assert.equal(runs, 2);
});
