/** Synthetic historical receipts exercise report arithmetic; they are not engineering proof [C7]. */
import { testCapacityReport } from '../../../../packages/gate/index.js';
import { flakeLedger } from '../../../../packages/flakes/index.js';
import { eventCauses } from '../../../../packages/store/index.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { main } from '../../tests/fixtures/native.js';
import {
  defaults,
  configFromSource,
} from '../../../../packages/config/index.js';
import { NATIVE_FLAKE_ENGINE } from '../../../../packages/state/light.js';
import { boardReceiptStore } from '../../../../packages/gate/index.js';
import {
  readTestValueTimings,
  retainTestValueTimings,
} from '../../../../packages/gate/index.js';
import { testValueReport } from '../../../../packages/gate/index.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';

const NOW = '2026-10-27T00:00:00.000Z';
const ENVIRONMENT = { node: '22.22.2', platform: 'linux', arch: 'x64' };

/** Create a real Git history and SQLite board under a deterministic report clock. */
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-test-value-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** Run bounded Git operations through the shared fixture custody helper. */
  const git = (...args) => runFixtureGit(args, { cwd: root });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(root, 'test'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: { core: { owns: ['src/', 'test/'] } } }));
  writeFileSync(join(root, 'DOCTRINE.md'), '');
  for (const file of ['alpha', 'beta', 'unknown', 'idle']) writeFileSync(join(root, `test/${file}.test.js`), '// Synthetic historical fixture.\n');
  writeFileSync(join(root, 'src/app.js'), 'export const value = 0;\n');
  /** Pin commit dates independently of the host calendar and user Git identity. */
  function commit(at, message) {
    git('add', '-A');
    runFixtureGit(['commit', '-q', '-m', message], { cwd: root, env: { ...process.env,
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
      GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
    return git('rev-parse', 'HEAD');
  }
  const initial = commit('2026-10-12T00:00:00Z', 'chore: fixture initial');
  writeFileSync(join(root, 'test/alpha.test.js'), '// Stable oracle added inside the window.\n');
  writeFileSync(join(root, 'test/beta.test.js'), '// Stable flake oracle.\n');
  const red = commit('2026-10-13T00:00:00Z', 'test: fixture oracles');
  writeFileSync(join(root, 'src/app.js'), 'export const value = 1;\n');
  const green = commit('2026-10-15T00:00:00Z', 'fix: product repair');
  let now = new Date(NOW);
  const clock = { now: () => new Date(now) };
  // @pullboard-board-file journey: the public report CLI reopens this Git project's persisted synthetic receipt history.
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), clock);
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: root });
  /** Append explicitly synthetic history to the real fixture board, never the shared project board. */
  function event(kind, item, at, value) {
    now = new Date(at);
    store.logEvent(board, 'coordinator', kind, item, value);
    now = new Date(NOW);
  }
  /** Seed a receipt with known file executions and explicitly synthetic timing observations. */
  function run(file, at, { commit: head = red, green: passed = true, duration = 1000, names = ['target'], item = 1, duplicate = false } = {}) {
    const id = randomUUID();
    const receipt = { id, kind: 'check', item, commit: head, tree: git('rev-parse', `${head}^{tree}`),
      sourceClean: true, at, exitCode: passed ? 0 : 1,
      testRuntimes: [{ pid: 100, file, environment: ENVIRONMENT }] };
    event('proof-run', item, at, { receipt });
    if (duplicate) event('proof-run', item, at, { receipt });
    if (duration !== null) assert.equal(retainTestValueTimings(boardReceiptStore(board), id, {
      files: [{ path: file, durationMs: duration }], tests: names.map(name => ({ file, name, passed })) }), true);
    return receipt;
  }
  /** Capture the real public command at the deterministic report observation time. */
  async function cli(...args) {
    let stdout = '', stderr = '';
    const code = await main(args, { cwd: root, clock,
      stdout: { isTTY: false, write: text => { stdout += text; } },
      stderr: { write: text => { stderr += text; } } });
    return { code, stdout, stderr, data: args.includes('--json') ? JSON.parse(stdout) : null };
  }
  return { root, board, initial, red, green, run, event, commit, git, cli };
}

test('[C7] fourteen-day fixture pins every test-value number, code catches, flakes, edits and ordering without writes', async t => {
  const f = fixture(t);
  const alpha = 'test/alpha.test.js', beta = 'test/beta.test.js';
  f.run(alpha, '2026-10-12T23:59:59.999Z', { duration: 9000 }); // Outside the inclusive boundary.
  f.run(alpha, '2026-10-13T00:00:00.000Z', { duration: 1000 });
  const red = f.run(alpha, '2026-10-14T00:00:00Z', { green: false, duration: 2000, names: ['target', 'second defect'], duplicate: true });
  f.event('reject', 1, '2026-10-14T00:00:01Z', { commit: f.red, reason: 'TEST_FAILURE', causes: [`test:${alpha}::target`, `test:${alpha}::second defect`] });
  f.event('reject', 1, '2026-10-14T00:00:02Z', { commit: f.red, reason: 'TEST_FAILURE', cause: `test:${alpha}::target` });
  const green = f.run(alpha, '2026-10-15T00:00:00Z', { commit: f.green, duration: 3000, names: ['target', 'second defect'] });
  f.event('accept', 1, '2026-10-15T00:00:01Z', { commit: f.green });
  f.run(alpha, '2026-10-27T00:00:00.001Z', { duration: 9000 }); // Future data is excluded.
  f.run(beta, '2026-10-14T01:00:00Z', { green: false, duration: 500, item: 2 });
  f.run(beta, '2026-10-15T01:00:00Z', { duration: 1500, item: 2 });
  const observation = { id: 'synthetic-flake', file: beta, name: 'target', classification: 'flake',
    head: f.red, at: '2026-10-14T01:00:01Z', original: { sha256: 'a'.repeat(64) } };
  f.event('flake-observation', null, observation.at, { engine: NATIVE_FLAKE_ENGINE, observation });
  f.event('flake-observation', null, observation.at, { engine: NATIVE_FLAKE_ENGINE, observation });
  f.run('test/unknown.test.js', '2026-10-16T00:00:00Z', { duration: null });
  const before = store.events(f.board);
  const result = await f.cli('test-value', '--json');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.data.version, 1);
  const report = result.data.report;
  assert.equal(report.since, '2026-10-13T00:00:00.000Z');
  assert.equal(report.asOf, NOW);
  assert.deepEqual(report.costs, { costOfEscape: 3600, costOfWaiting: 1, costOfFalseRed: 300 });
  assert.deepEqual(report.files.map(row => row.file), [alpha, beta, 'test/idle.test.js', 'test/unknown.test.js']);
  const first = report.files[0];
  assert.deepEqual({ ...first, catches: [], receiptIds: [] }, { file: alpha, runs: 3, realCatches: 2, flakes: 0,
    runtimeMs: 6000, timedRuns: 3, namedOutcomeRuns: 3, meanRuntimeMs: 2000, edits: 1, catchRate: 1 / 3, flakeRate: 0,
    valuePerRun: 1198, catchRuns: 1, flakeRuns: 0, unmatchedFlakes: 0, unattributedFailures: 0, catches: [], receiptIds: [], lastObservedRuntime: null, estimatedValuePerRun: null });
  assert.equal(first.catches.length, 2);
  assert.ok(first.catches.every(row => row.red === red.id && row.green === green.id));
  const second = report.files[1];
  assert.deepEqual([second.runs, second.realCatches, second.flakes, second.runtimeMs, second.meanRuntimeMs,
    second.edits, second.catchRate, second.flakeRate, second.valuePerRun], [2, 0, 1, 2000, 1000, 1, 0, 0.5, -151]);
  const idle = report.files[2], unknown = report.files[3];
  assert.deepEqual([idle.runs, idle.runtimeMs, idle.catchRate, idle.flakeRate, idle.valuePerRun], [0, null, null, null, null]);
  assert.deepEqual([unknown.runs, unknown.timedRuns, unknown.meanRuntimeMs, unknown.valuePerRun], [1, 0, null, null]);
  assert.deepEqual(report.coverage, { receipts: 6, unknownFileReceipts: 0, gitHistoryAvailable: true, unknownCommitReceipts: 0, untrackedFileExecutions: 0, nonTestFileExecutions: 0 });
  const text = await f.cli('test-value');
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /2 catches \(code-fixed or native audit\); 0 flakes; runtime 2000ms\/run; 1 edits; value 1198 per run/u);
  assert.match(text.stdout, /runtime unknown/u);
  assert.deepEqual(store.events(f.board), before, 'both public report forms append no event');
});

test('[C7] broad red, missing exact green, changed oracle, ambiguous flakes and legacy runs stay unattributed', t => {
  const f = fixture(t), file = 'test/alpha.test.js';
  f.run(file, '2026-10-14T00:00:00Z', { green: false, names: ['another case'] });
  f.event('reject', 1, '2026-10-14T00:00:01Z', { commit: f.red, cause: `test:${file}::target` });
  f.run(file, '2026-10-15T00:00:00Z', { commit: f.green, names: ['target'] });
  f.event('accept', 1, '2026-10-15T00:00:01Z', { commit: f.green });
  let report = testValueReport(f.board, { root: f.root, costs: defaults().testEconomics, now: Date.parse(NOW) }, { flakeLedger, eventCauses });
  assert.equal(report.files.find(row => row.file === file).realCatches, 0, 'executing the file is not the named failure');
  assert.equal(report.files.find(row => row.file === file).unattributedFailures, 1);
  assert.equal(report.files.find(row => row.file === file).catchRate, null, 'an unresolved known failure is not a measured zero catch rate');
  const beta = 'test/beta.test.js';
  f.run(beta, '2026-10-14T02:00:00Z', { green: false, item: 2 });
  f.run(beta, '2026-10-14T02:00:01Z', { green: false, item: 2 });
  f.event('flake-observation', null, '2026-10-14T02:00:02Z', { engine: NATIVE_FLAKE_ENGINE,
    observation: { id: 'ambiguous', file: beta, name: 'target', head: f.red,
      at: '2026-10-14T02:00:02Z', classification: 'flake', original: { sha256: 'b'.repeat(64) } } });
  f.event('proof-run', 3, '2026-10-17T00:00:00Z', { receipt: { id: randomUUID(), at: '2026-10-17T00:00:00Z', testRuntimes: null } });
  report = testValueReport(f.board, { root: f.root, costs: defaults().testEconomics, now: Date.parse(NOW) }, { flakeLedger, eventCauses });
  const row = report.files.find(value => value.file === beta);
  assert.equal(row.flakes, 1);
  assert.equal(row.unmatchedFlakes, 1);
  assert.equal(row.flakeRate, null);
  assert.equal(row.valuePerRun, null);
  assert.equal(report.coverage.unknownFileReceipts, 1);
  f.run('test/unknown.test.js', '2026-10-16T00:00:00Z', { green: false, item: 5 });
  f.event('reject', 5, '2026-10-16T00:00:01Z', { commit: f.red, cause: 'test:test/unknown.test.js::target' });
  f.run('test/unknown.test.js', '2026-10-16T00:00:02Z', { commit: f.green, names: ['another case'], item: 5 });
  f.event('accept', 5, '2026-10-16T00:00:03Z', { commit: f.green });
  report = testValueReport(f.board, { root: f.root, costs: defaults().testEconomics, now: Date.parse(NOW) }, { flakeLedger, eventCauses });
  assert.equal(report.files.find(value => value.file === 'test/unknown.test.js').realCatches, 0,
    'a different named green case cannot close the original failure');
  // A different item's exact failure followed by a test rewrite is not a product-code catch.
  f.run('test/unknown.test.js', '2026-10-18T00:00:00Z', { green: false, item: 4 });
  f.event('reopen', 4, '2026-10-18T00:00:01Z', { commit: f.red, landingFailure: { tests: [{ file: 'test/unknown.test.js', name: 'target' }] } });
  writeFileSync(join(f.root, 'test/unknown.test.js'), '// Changed oracle; green cannot prove code repair.\n');
  const changed = f.commit('2026-10-19T00:00:00Z', 'test: rewrite oracle');
  f.run('test/unknown.test.js', '2026-10-19T00:00:01Z', { commit: changed, item: 4 });
  f.event('accept', 4, '2026-10-19T00:00:02Z', { commit: changed });
  report = testValueReport(f.board, { root: f.root, costs: defaults().testEconomics, now: Date.parse(NOW) }, { flakeLedger, eventCauses });
  assert.equal(report.files.find(value => value.file === 'test/unknown.test.js').realCatches, 0);
});

test('[C7] costs are validated board configuration with safe defaults, exposed in CLI help', async t => {
  const f = fixture(t);
  assert.deepEqual(configFromSource('{"testEconomics":{"costOfWaiting":2}}').testEconomics,
    { costOfEscape: 3600, costOfWaiting: 2, costOfFalseRed: 300 });
  for (const value of [null, [], { costOfWaiting: -1 }, { costOfEscape: 'large' }]) {
    assert.throws(() => configFromSource(JSON.stringify({ testEconomics: value })), error => error.code === 'BAD_CONFIG');
  }
  assert.deepEqual(configFromSource('{"testEconomics":{"unknown":1}}').testEconomics, defaults().testEconomics,
    'forward-compatible unknown keys leave the safe defaults unchanged');
  const config = JSON.parse(readFileSync(join(f.root, 'pullboard.json'), 'utf8'));
  writeFileSync(join(f.root, 'pullboard.json'), JSON.stringify({ ...config, testEconomics: { costOfEscape: 10, costOfWaiting: 0, costOfFalseRed: 0 } }));
  const json = await f.cli('test-value', '--json');
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(json.data.report.costs, { costOfEscape: 10, costOfWaiting: 0, costOfFalseRed: 0 });
  const help = await f.cli('test-value', '--help');
  assert.equal(help.code, 0);
  assert.match(help.stdout, /fourteen-day|test-value/u);
  const bad = await f.cli('test-value', 'unexpected', '--json');
  assert.equal(bad.code, 1);
  assert.equal(bad.data.error.code, 'USAGE');
});

test('[C7] immutable receipt timings preserve duplicate executions, prefer landing file wall times and reject foreign paths', t => {
  const f = fixture(t), directory = boardReceiptStore(f.board), id = randomUUID();
  assert.equal(retainTestValueTimings(directory, id, { files: [{ path: 'test/a.test.js', durationMs: 999 }],
    landingShards: { files: [{ path: 'test/a.test.js', durationMs: 10 }, { path: 'test/a.test.js', durationMs: 20 }, { path: '../foreign.js', durationMs: 50 }] },
    tests: [{ file: 'test/a.test.js', name: 'target', passed: true }, { file: null, name: 'unattributed', passed: true }] }), true);
  assert.deepEqual(readTestValueTimings(directory, id), { version: 1, receiptId: id,
    files: [{ file: 'test/a.test.js', durationMs: 10 }, { file: 'test/a.test.js', durationMs: 20 }],
    tests: [{ file: 'test/a.test.js', name: 'target', passed: true }] });
  assert.equal(retainTestValueTimings(directory, id, { files: [] }), false, 'a later run cannot overwrite the first receipt sample');
  assert.equal(readTestValueTimings(directory, '../outside'), null);
  const bad = randomUUID();
  writeFileSync(join(directory, 'test-value', `${bad}.json`), JSON.stringify({ version: 1, receiptId: bad, files: [{ file: '/foreign.js', durationMs: 1 }] }));
  assert.equal(readTestValueTimings(directory, bad), null);
});


test('[C7] nested fixture names and unavailable commits cannot become project test executions', t => {
  const f = fixture(t);
  f.run('.timed/fast.test.js', '2026-10-14T00:00:00Z');
  f.run('test/helper.js', '2026-10-14T00:00:01Z');
  // A root blob is necessary, but a helper is not thereby a test file.
  writeFileSync(join(f.root, 'test/helper.js'), '// A tracked helper, never a project test.\n');
  const head = f.commit('2026-10-16T00:00:00Z', 'test: tracked helper');
  f.run('test/helper.js', '2026-10-17T00:00:00Z', { commit: head });
  f.event('proof-run', 1, '2026-10-18T00:00:00Z', { receipt: { id: randomUUID(), at: '2026-10-18T00:00:00Z',
    commit: 'f'.repeat(40), sourceClean: true, exitCode: 0,
    testRuntimes: [{ pid: 100, file: 'test/alpha.test.js', environment: ENVIRONMENT }] } });
  f.run('test/alpha.test.js', '2026-10-19T00:00:00Z');
  const before = store.events(f.board);
  const report = testValueReport(f.board, { root: f.root, costs: defaults().testEconomics, now: Date.parse(NOW) }, { flakeLedger, eventCauses });
  assert.deepEqual(report.files.map(row => row.file).sort(), ['test/alpha.test.js', 'test/beta.test.js', 'test/idle.test.js', 'test/unknown.test.js']);
  assert.equal(report.files.find(row => row.file === 'test/alpha.test.js').runs, 1);
  assert.equal(report.coverage.unknownCommitReceipts, 1);
  assert.equal(report.coverage.untrackedFileExecutions, 1);
  assert.equal(report.coverage.nonTestFileExecutions, 2);
  assert.deepEqual(store.events(f.board), before);
});

test('[C7] existing landing file times give a labelled last-observed estimate, never invented historical totals', async t => {
  const f = fixture(t), file = 'test/alpha.test.js';
  f.run(file, '2026-10-14T00:00:00Z', { duration: null });
  const path = join(f.root, '.git', 'pullboard', 'landing-file-times.json');
  writeFileSync(path, JSON.stringify({ version: 1, files: { [file]: 4321, '.timed/fixture.test.js': 99 } }));
  const before = readFileSync(path, 'utf8');
  const report = testValueReport(f.board, { root: f.root, costs: defaults().testEconomics, now: Date.parse(NOW) }, { flakeLedger, eventCauses });
  const row = report.files.find(row => row.file === file);
  assert.equal(row.runs, 1);
  assert.equal(row.runtimeMs, null);
  assert.equal(row.timedRuns, 0);
  assert.equal(row.meanRuntimeMs, null);
  assert.deepEqual(row.lastObservedRuntime, { durationMs: 4321, source: 'landing-file-times', ageMs: null });
  assert.equal(row.catchRate, null, 'missing named historical outcomes are unknown, not a measured zero catch rate');
  assert.equal(row.valuePerRun, null);
  assert.equal(row.estimatedValuePerRun, null, 'a runtime sample cannot invent a catch probability');
  assert.equal(report.files.some(row => row.file === '.timed/fixture.test.js'), false);
  const text = await f.cli('test-value');
  assert.match(text.stdout, /last observed 4321ms \(landing-file-times; age unknown\)/u);
  assert.equal(readFileSync(path, 'utf8'), before, 'a report never rewrites its source observations');
});


test('[C7] a single-file native receipt supplies observed wall time, never aggregate multi-file time', t => {
  const f = fixture(t), file = 'test/alpha.test.js';
  const id = randomUUID();
  f.event('proof-run', 1, '2026-10-26T00:00:00Z', { receipt: { id, at: '2026-10-26T00:00:00Z',
    commit: f.red, sourceClean: true, exitCode: 0, durationMs: 2500,
    testRuntimes: [{ pid: 100, file, environment: ENVIRONMENT }] } });
  assert.equal(retainTestValueTimings(boardReceiptStore(f.board), id, { files: [], tests: [{ file, name: 'target', passed: true }] }), true);
  f.event('proof-run', 1, '2026-10-26T01:00:00Z', { receipt: { id: randomUUID(), at: '2026-10-26T01:00:00Z',
    commit: f.red, sourceClean: true, exitCode: 0, durationMs: 99999,
    testRuntimes: [{ pid: 101, file: 'test/beta.test.js', environment: ENVIRONMENT }, { pid: 102, file: 'test/idle.test.js', environment: ENVIRONMENT }] } });
  const report = testValueReport(f.board, { root: f.root, costs: defaults().testEconomics, now: Date.parse(NOW) }, { flakeLedger, eventCauses });
  const row = report.files.find(row => row.file === file);
  assert.deepEqual(row.lastObservedRuntime, { durationMs: 2500, source: 'native-single-file-receipt', receiptId: id, ageMs: 86400000 });
  assert.equal(row.runtimeMs, null);
  assert.equal(row.meanRuntimeMs, null);
  assert.equal(row.valuePerRun, null);
  assert.equal(row.estimatedValuePerRun, -2.5, 'a separately labelled estimate applies the rule without inventing a complete mean');
  assert.equal(report.files.find(row => row.file === 'test/beta.test.js').lastObservedRuntime, null);
});


test('[C7] one unbound named outcome cannot cover two same-file worker executions', t => {
  const f = fixture(t), file = 'test/alpha.test.js', id = randomUUID();
  f.event('proof-run', 1, '2026-10-14T00:00:00Z', { receipt: { id, at: '2026-10-14T00:00:00Z',
    commit: f.red, sourceClean: true, exitCode: 1,
    testRuntimes: [{ pid: 100, file, environment: ENVIRONMENT }, { pid: 101, file, environment: ENVIRONMENT }] } });
  assert.equal(retainTestValueTimings(boardReceiptStore(f.board), id, {
    files: [{ path: file, durationMs: 1000 }, { path: file, durationMs: 2000 }],
    tests: [{ file, name: 'target', passed: false }],
  }), true);
  f.run('test/beta.test.js', '2026-10-15T00:00:00Z', { duration: 1000 });
  let report = testValueReport(f.board, { root: f.root, costs: defaults().testEconomics, now: Date.parse(NOW) }, { flakeLedger, eventCauses });
  const row = report.files.find(row => row.file === file);
  assert.equal(row.runs, 2);
  assert.equal(row.timedRuns, 2);
  assert.equal(row.meanRuntimeMs, 1500, 'complete durations do not imply complete named outcomes');
  assert.equal(row.namedOutcomeRuns, 0);
  assert.equal(row.catchRate, null);
  assert.equal(row.flakeRate, null);
  assert.equal(row.valuePerRun, null);
  assert.equal(row.estimatedValuePerRun, null);
  assert.equal(report.files.find(row => row.file === 'test/beta.test.js').valuePerRun, -1,
    'an independently observed single execution retains the measured scenario');
  // Even a uniquely matching receipt cannot assign a same-head flake to one of its unbound workers.
  f.event('flake-observation', null, '2026-10-14T00:00:01Z', { engine: NATIVE_FLAKE_ENGINE,
    observation: { id: 'ambiguous-workers', file, name: 'target', head: f.red,
      at: '2026-10-14T00:00:01Z', classification: 'flake', original: { sha256: 'c'.repeat(64) } } });
  report = testValueReport(f.board, { root: f.root, costs: defaults().testEconomics, now: Date.parse(NOW) }, { flakeLedger, eventCauses });
  assert.equal(report.files.find(row => row.file === file).flakeRate, null);
  assert.equal(report.files.find(row => row.file === file).unmatchedFlakes, 1,
    'a unique receipt still has two possible failing worker attempts');
});

/** Lower report readers refuse missing composition ports rather than importing a later cell implicitly. */
test('value and capacity reports need explicit historical evidence readers [C7,doctrine:CD64]', t => {
  const f = fixture(t);
  const options = { root: f.root, costs: defaults().testEconomics, now: Date.parse(NOW) };
  assert.throws(() => testValueReport(f.board, options), /explicit flake ledger and cause readers/u);
  assert.throws(() => testValueReport(f.board, options, { flakeLedger }), /explicit flake ledger and cause readers/u);
  assert.throws(() => testCapacityReport(f.board, options, { flakeLedger, eventCauses }), /explicit native gate-run reader/u);
});
