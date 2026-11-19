/** The runner gate job entry copies the analysis's static known-main rows into the receipt's analysis [C7,#10567]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateJobRequest } from '../../../src/io/submit/pull.js';

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
