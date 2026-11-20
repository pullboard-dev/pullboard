/** The runner gate job entry copies the analysis's static known-main rows into the receipt's analysis [C7,#10567]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateJobRequest } from '../../../src/io/submit/pull.js';
import { proofRunnerNote } from '../../../src/io/submit/pull.js';
import { submitAckLines } from '../../../src/io/submit/pull.js';
import { proofShardPlan } from '../../../src/io/submit/pull.js';

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

test('cli.io-submit-pull.ack-prints-runner-note: clause 3: the submit acknowledgment says the runner note right after the in-the-gate line [C7,#11753]', () => {
  const main = { commit: MAIN_SHA, config: { affectedTests: 'npx jest' } };
  const lines = submitAckLines({ id: 1, jobId: `gate:1:${'d'.repeat(12)}:abc`, local: { started: true, pid: 4242 }, config: { affectedTests: 'npx jest' }, main, source: ITEM_SHA });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^#1 is in the gate as job gate:1:d{12}:abc: a runner pulls the whole gate.*Started this machine's local runner \(pid 4242\)/u, 'the submit says it is in the gate');
  assert.match(lines[1], /^test runner: /u, 'the runner note follows at once');
  assert.equal(lines[1], proofRunnerNote({ affectedTests: 'npx jest' }, main, ITEM_SHA));
  assert.doesNotMatch(submitAckLines({ id: 1, jobId: 'j', local: { started: false }, config: {}, main, source: ITEM_SHA })[0], /local runner/u);
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

const ENTRY_REQUEST = { main: 'a'.repeat(40), source: 'b'.repeat(40), trunk: 'a'.repeat(40), base: null, check: 'true', criterion: '', title: 't',
  composition: null, config: {}, crossRunTests: [], cutRows: [], produceInventory: [], doctrine: null, authorization: null, browserFreeChecks: false };

test('cli.io-submit-pull.proof-plan-needs: clause 1: the gate entry sets receipt.proofPlan.needs to the browser files and the GUI files of the proof files, and a throw or a missing export declares none [C7,#11831]', async () => {
  const { input } = gateJobRequest(ENTRY_REQUEST);
  const from = input.entry.indexOf('const proofNeeds = async files'), to = input.entry.indexOf('const shardBrowserless', from);
  assert.ok(from > 0 && to > from, 'the entry carries proofNeeds');
  assert.ok(input.entry.includes('receipt.proofPlan = shardPlan; receipt.proofPlan.needs = await proofNeeds(plan.proofFiles);'), 'the needs ride on the plan at the line that sets it');
  const build = (gate) => new Function('gate', 'root', `${input.entry.slice(from, to)} return proofNeeds;`)(gate, '/r');
  const gate = { testsNeedBrowser: async (root, files) => root === '/r' && files[0] === 'b.test.js', testsNeedGui: (root, files) => files[0] === 'c.test.js' };
  assert.deepEqual(await build(gate)(PLAN.proofFiles), { browser: ['b.test.js'], gui: ['c.test.js'] });
  const throwing = { testsNeedBrowser: async () => { throw new Error('unreadable'); }, testsNeedGui: () => { throw new Error('unreadable'); } };
  assert.deepEqual(await build(throwing)(PLAN.proofFiles), { browser: [], gui: [] });
  assert.deepEqual(await build(null)(PLAN.proofFiles), { browser: [], gui: [] });
});

test('cli.io-submit-pull.shard-plan-env: clause 2: a shard run with input.shard.plan runs its proof phase with PULLBOARD_SHARD_PLAN set to that plan as JSON, and with no plan sets none [C7,#11831]', () => {
  const { input } = gateJobRequest(ENTRY_REQUEST);
  const from = input.entry.indexOf('const inheritedEnv = { ...process.env };'), end = input.entry.indexOf('const capture = role', from);
  assert.ok(from > 0 && end > from, 'the entry builds the phase environment from inherited env and the shard plan');
  const build = (shard, inherited) => {
    const saved = process.env.PULLBOARD_SHARD_PLAN;
    if (inherited === undefined) delete process.env.PULLBOARD_SHARD_PLAN; else process.env.PULLBOARD_SHARD_PLAN = inherited;
    try {
      return new Function('shard', 'role', 'gate', 'PATH', 'run', 'hitsFile', 'sharedResultStore', 'selected', 'root',
        `${input.entry.slice(from, end)} return phaseEnv;`)(shard, 'proof', null, '/bin', { id: 'r' }, null, () => ({}), null, '/r');
    } finally { if (saved === undefined) delete process.env.PULLBOARD_SHARD_PLAN; else process.env.PULLBOARD_SHARD_PLAN = saved; }
  };
  const plan = { browser: true, gui: false };
  assert.deepEqual(JSON.parse(build({ plan }).PULLBOARD_SHARD_PLAN), plan);
  assert.equal('PULLBOARD_SHARD_PLAN' in build({}), false);
  assert.equal('PULLBOARD_SHARD_PLAN' in build(null), false);
  assert.equal('PULLBOARD_SHARD_PLAN' in build({}, '{"browser":true,"gui":true}'), false);
});
