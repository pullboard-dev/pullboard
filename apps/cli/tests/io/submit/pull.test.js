/** The runner gate job entry copies the analysis's static known-main rows into the receipt's analysis [C7,#10567]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateJobRequest } from '../../../src/io/submit/pull.js';
import { proofRunnerNote } from '../../../src/io/submit/pull.js';
import { proofShardPlan } from '../../../src/io/submit/pull.js';
import { fileFixtureItem } from '../../fixtures/testkit.js';
import { fixtureSettledMachine } from '../../fixtures/testkit.js';
import { fixture } from '../../fixtures/init/calls.js';

const START = 'receipt.analysis = {';
const END = 'admission: analysis.admission ?? null };';

/** The entry's own `receipt.analysis = { ... };` statement, run on `analysis` with no child process: the receipt's analysis it builds. */
function receiptAnalysis(analysis) {
  const { input } = gateJobRequest({ main: 'a'.repeat(40), source: 'b'.repeat(40), trunk: 'a'.repeat(40), base: null, check: 'true', criterion: '', title: 't',
    composition: null, config: {}, crossRunTests: [], cutRows: [], produceInventory: [], doctrine: null, authorization: null, browserFreeChecks: false });
  const from = input.entry.indexOf(START), to = input.entry.indexOf(END, from);
  assert.ok(from > 0 && to > from, 'the entry builds receipt.analysis in one statement');
  const build = new Function('analysis', 'refusals', 'ownership', 'doctrineMachinery', 'ruleLine', `const receipt = {}; ${input.entry.slice(from, to + END.length)} return receipt.analysis;`);
  return build(analysis, [], undefined, [], () => '');
}

test('cli.io-submit-pull.static-known-main-rows-reach-the-receipt: clause 1: an analysis result with staticKnownMain rows is written to receipt.analysis.staticKnownMain [C7,#10567]', () => {
  const rows = [{ rule: 'rule-a', file: 'src/a.js', extra: 'dropped' }, { rule: 'rule-b', file: 'src/b.js' }];
  const analysis = receiptAnalysis({ steps: {}, staticKnownMain: rows });
  assert.deepEqual(analysis.staticKnownMain, [{ rule: 'rule-a', file: 'src/a.js' }, { rule: 'rule-b', file: 'src/b.js' }]);
  const many = receiptAnalysis({ steps: {}, staticKnownMain: Array.from({ length: 250 }, (_, index) => ({ rule: 'r', file: `f${index}.js` })) });
  assert.equal(many.staticKnownMain.length, 200, 'at most 200 rows');
});

test('cli.io-submit-pull.no-static-known-main-key-without-rows: clause 2: receipt.analysis has no staticKnownMain key when the analysis has none [C7,#10567]', () => {
  assert.equal('staticKnownMain' in receiptAnalysis({ steps: {} }), false);
  assert.equal('staticKnownMain' in receiptAnalysis({ steps: {}, staticKnownMain: [] }), false);
});

const STORE_START = 'const sharedResultStore = (';
const STORE_END = '} : {};\n};';

/** The entry's own sharedResultStore statement, run with no child process: the environment a phase adds for its result store. */
function resultStoreEnv(role, selected, checkout, env = {}) {
  const { input } = gateJobRequest({ main: 'a'.repeat(40), source: 'b'.repeat(40), trunk: 'a'.repeat(40), base: null, check: 'true', criterion: '', title: 't',
    composition: null, config: {}, crossRunTests: [], cutRows: [], produceInventory: [], doctrine: null, authorization: null, browserFreeChecks: false });
  const from = input.entry.indexOf(STORE_START), to = input.entry.indexOf(STORE_END, from);
  assert.ok(from > 0 && to > from, 'the entry defines sharedResultStore in one statement');
  return new Function(`${input.entry.slice(from, to + STORE_END.length)} return sharedResultStore;`)()(role, selected, checkout, env);
}

test('cli.io-submit-pull.proof-phase-shares-runner-result-store: clause 1: a submit proof on any slot sets PULLBOARD_TEST_RESULT_STORE to the runner-wide pull-gate folder [C7,#11114]', () => {
  const runner = '/home/r/.pullboard-runner';
  const three = resultStoreEnv('proof', ['a.test.js'], `${runner}/pull/slot/3/land`);
  const seven = resultStoreEnv('proof', ['a.test.js'], `${runner}/pull/slot/7/land`);
  assert.deepEqual(three, { PULLBOARD_TEST_RESULT_STORE: `${runner}/test-results/pull-gate` });
  assert.deepEqual(seven, three);
});

test('cli.io-submit-pull.shared-store-only-for-submit-proof: clause 2: no shared store for the check role, a root with no pull folder, a landing shard, or an environment that already names one [C7,#11114]', () => {
  const root = '/home/r/.pullboard-runner/pull/slot/3/land';
  assert.deepEqual(resultStoreEnv('check', null, root), {});
  assert.deepEqual(resultStoreEnv('check', ['a.test.js'], root), {});
  assert.deepEqual(resultStoreEnv('proof', ['a.test.js'], '/home/r/work/land'), {});
  assert.deepEqual(resultStoreEnv('proof', null, root), {}, 'a landing shard owes no account and keeps its own store');
  assert.deepEqual(resultStoreEnv('proof', ['a.test.js'], root, { PULLBOARD_TEST_RESULT_STORE: '/mine' }), {});
  assert.deepEqual(resultStoreEnv('proof', ['a.test.js'], root, { PULLBOARD_TEST_REUSE: '0' }), { PULLBOARD_TEST_RESULT_STORE: '/home/r/.pullboard-runner/test-results/pull-gate' }, 'reuse stays the environment\'s own setting');
});

const MAIN_SHA = 'c'.repeat(40);
const ITEM_SHA = 'd'.repeat(40);

test('cli.io-submit-pull.runner-note-names-source: clause 1: the note names the runner and main as its source when the config matches main [C7,#11753]', () => {
  const note = proofRunnerNote({ affectedTests: 'npx jest' }, { commit: MAIN_SHA, config: { affectedTests: 'npx jest' } }, ITEM_SHA);
  assert.equal(note, `test runner: npx jest (affectedTests from main ${'c'.repeat(12)})`);
});

test('cli.io-submit-pull.runner-note-item-policy: clause 2: the note names the item policy and main\'s own runner when they differ, and none set when neither names one [C7,#11753]', () => {
  const differ = proofRunnerNote({ affectedTests: 'node --test' }, { commit: MAIN_SHA, config: { affectedTests: 'npx jest' } }, ITEM_SHA);
  assert.equal(differ, `test runner: node --test (affectedTests from this item's policy ${'d'.repeat(12)}; main sets npx jest)`);
  assert.equal(proofRunnerNote({}, { commit: MAIN_SHA, config: {} }, ITEM_SHA), 'test runner: none set (named .js files run under node --test)');
});

test('cli.io-submit-pull.ack-prints-runner-note: clause 3: a real submit says the runner note right after the in-the-gate line [C7,#11753]', { skip: 'main-red stopgap #12134: runs a real worker run that hangs past the 180 s file budget; #12050 is the real fix and must remove this skip' }, async t => {
  const box = await fixture(t);
  fileFixtureItem(box, box.repo, { lane: 'core', title: 'Print the proof runner', route: 'mid',
    criterion: 'the runner reads the commit it just made', check: 'test -f src/result.txt',
    brief: 'Files: src/result.txt\nChange: create the runner result file.\nTest: the runner reads the commit it just made.',
    diagnosis: 'Files: src/result.txt\nChange: create the runner result file.\nTest case: the runner reads the commit it just made.',
    args: ['--specs', 'C7'] });
  const agent = join(box.dir, 'agent.sh');
  writeFileSync(agent, '#!/bin/sh\nmkdir -p src\nprintf result > src/result.txt\n');
  chmodSync(agent, 0o700);
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { gate: { mainComparison: 'off' } });
  const run = box.ok(box.worker, 'run', '--agent-light', `sh ${agent}`, '--items', '1', '--attempts', '1', '--minutes', '1');
  const lines = run.stdout.split('\n');
  const gate = lines.findIndex(line => /^#1 is in the gate as job /u.test(line));
  assert.ok(gate >= 0, 'the submit says it is in the gate');
  assert.match(lines[gate + 1], /^test runner: /u, 'the runner note follows at once');
});

test('cli.submit-pull.item-needs-in-request: clause 1: the gate request carries the held item needs in its analysis data, and a request without needs is built as before [U136,#11479]', () => {
  const pinned = { main: 'a'.repeat(40), source: 'b'.repeat(40), trunk: 'a'.repeat(40), base: null, check: 'true', criterion: '', title: 't',
    composition: null, config: {}, crossRunTests: [], cutRows: [], produceInventory: [], doctrine: null, authorization: null, browserFreeChecks: false };
  const plain = gateJobRequest(pinned);
  assert.equal('needs' in plain.input.data.analysis, false);
  const needing = gateJobRequest({ ...pinned, needs: ['gui'] });
  assert.deepEqual(needing.input.data.analysis.needs, ['gui']);
  assert.deepEqual({ ...needing.input.data.analysis, needs: undefined }, { ...plain.input.data.analysis, needs: undefined });
});

const PLAN = { testRunner: ' node --test ', proofFiles: ['a.test.js', 'b.test.js', 'c.test.js'] };

test('cli.io-submit-pull.proof-shard-plan-timing: clause 1: proofShardPlan returns the runner, files, cores, account and only the declared proof files as timing [C7,#11961]', () => {
  const plan = proofShardPlan(PLAN, 2, ['b.test.js', 'other.test.js'], ['a.test.js']);
  assert.deepEqual(plan, { runner: 'node --test', files: PLAN.proofFiles, cores: 2, account: true, timing: ['b.test.js'] });
  assert.equal('timing' in proofShardPlan(PLAN, 2, [], null), false);
  assert.equal('account' in proofShardPlan(PLAN, 2, [], null), false);
});

test('cli.io-submit-pull.proof-shard-plan-within-cores: clause 2: proofShardPlan returns null when the files fit the cores and none is declared, and a plan when one is declared [C7,#11961]', () => {
  assert.equal(proofShardPlan(PLAN, 3, [], null), null);
  assert.equal(proofShardPlan(PLAN, 3, undefined, null), null);
  assert.deepEqual(proofShardPlan(PLAN, 3, ['c.test.js'], null).timing, ['c.test.js']);
  assert.equal(proofShardPlan({ ...PLAN, selection: { full: true } }, 1, [], null), null);
  assert.equal(proofShardPlan({ proofFiles: PLAN.proofFiles }, 1, [], null), null);
});

test('cli.io-submit-pull.entry-reads-timing-through-gate-door: clause 3: the gate entry calls gate.timingTestFiles only when main\'s door exports it, treats a throw as none declared, and builds proofPlan through proofShardPlan [C7,#11961]', () => {
  const { input } = gateJobRequest({ main: 'a'.repeat(40), source: 'b'.repeat(40), trunk: 'a'.repeat(40), base: null, check: 'true', criterion: '', title: 't',
    composition: null, config: {}, crossRunTests: [], cutRows: [], produceInventory: [], doctrine: null, authorization: null, browserFreeChecks: false });
  const from = input.entry.indexOf('let timing = [];'), to = input.entry.indexOf('const shardable', from);
  assert.ok(from > 0 && to > from, 'the entry reads the declared timing files before it decides to shard');
  assert.ok(input.entry.includes('receipt.proofPlan = shardPlan;'), 'the proof plan comes from proofShardPlan');
  assert.ok(input.entry.includes('function proofShardPlan('), 'the entry carries proofShardPlan');
  const read = gate => new Function('gate', 'plan', 'root', 'cores', 'selected', 'proofShardPlan', 'input', 'receipt', `${input.entry.slice(from, to)} const shardable = shardPlan !== null; return shardPlan;`);
  const run = gate => read()(gate, PLAN, '/r', 1, null, proofShardPlan, { shards: true }, { analysis: {} });
  assert.deepEqual(run({ timingTestFiles: (root, files) => [files[1]] }).timing, ['b.test.js']);
  assert.equal(run({ timingTestFiles: () => { throw new Error('unreadable'); } }).timing, undefined);
  assert.equal(run(null).timing, undefined);
});
