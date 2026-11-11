/** @pullboard-test-input source-tree */
/** @pullboard-test-input .github/workflows/gate.yml */
/** CI evaluates synthetic reports without a private 3000-item browser burner [N40,C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../../../../apps/cli/tests/fixtures/child.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const BIN = join(ROOT, 'packages/gate/src/io/check/budgets.js');
const ACTIONS = [
  'firstLoad', 'switchProject', 'tab:shouts', 'tab:spec', 'tab:doctrine', 'tab:activity',
  'tab:roadmap', 'tab:items', 'openSmallItem', 'openLongestHistoryItem', 'search',
];

/** Synthetic schema-shaped measurements prove policy handling, never actual view speed or browser timing. */
function report() {
  return {
    version: 1, size: 3000, projects: 8, runs: 1, idleMs: 30_000,
    actions: [
      ...ACTIONS.map(name => ({ name, medianMs: 100, worstMs: 250 })),
      { name: 'idleWithLiveWrites', medianMs: 30_020, worstMs: 30_020,
        samples: [{ liveWrites: 2, liveWriteOffsetsMs: [0, 5000], renderedAtMs: [18, 5031] }] },
    ],
    table: '| action | median stable ms | worst stable ms |\n|---|---:|---:|\n'
      + ACTIONS.map(name => '| ' + name + ' | 100 | 250 |').join('\n')
      + '\n| idleWithLiveWrites | 30020 | 30020 |',
  };
}

test('perf budgets warn by name and fail on a missing action [N40,C7]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-perf-budgets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let sequence = 0;
  /** Run the actual reporter against a saved harness-shaped file and read its separate artifacts. */
  const run = (value, { combined = false } = {}) => {
    const fixture = join(directory, 'case-' + (++sequence));
    const inputDirectory = join(fixture, 'disposable-workspace');
    const outputDirectory = join(fixture, 'artifacts');
    mkdirSync(inputDirectory, { recursive: true });
    const input = join(inputDirectory, 'harness-output.txt');
    writeFileSync(input, JSON.stringify(value, null, 2) + (combined ? '\n\n' + value.table + '\n' : '\n'));
    const child = runFixtureChild(process.execPath, [BIN, input, outputDirectory], { cwd: ROOT, env: process.env, encoding: 'utf8' });
    return { child, inputDirectory, outputDirectory };
  };
  const under = run(report(), { combined: true });
  assert.equal(under.child.status, 0, under.child.stderr);
  assert.ok(!under.child.stdout.includes('::warning::'));
  const underSummary = JSON.parse(readFileSync(join(under.outputDirectory, 'budgets.json'), 'utf8'));
  assert.equal(underSummary.interactions.length, 11, 'all eleven eight-project interactions have fixed budgets');
  assert.deepEqual(underSummary.errors, []);
  assert.deepEqual(underSummary.warnings, []);
  assert.deepEqual(underSummary.observations, [{
    name: 'idleWithLiveWrites', windowMs: 30_000, budget: null,
    runs: [{ run: 1, liveWriteOffsetsMs: [0, 5000], renderedAtMs: [18, 5031] }],
  }], 'idle is the full window and exact observed offsets, with no latency threshold');
  const markdown = readFileSync(join(under.outputDirectory, 'performance.md'), 'utf8');
  assert.ok(markdown.includes('| idleWithLiveWrites | — | — | none | none | 30000 ms observation; no latency budget |'));
  assert.ok(markdown.includes('| 1 | 0, 5000 | 18, 5031 |'));
  rmSync(under.inputDirectory, { recursive: true });
  assert.equal(JSON.parse(readFileSync(join(under.outputDirectory, 'performance.json'), 'utf8')).projects, 8,
    'the JSON and table survive cleanup of the disposable input workspace');
  assert.ok(readFileSync(join(under.outputDirectory, 'performance.md'), 'utf8').includes('switchProject'));

  const over = report();
  over.actions.find(action => action.name === 'search').medianMs = 101;
  over.actions.find(action => action.name === 'search').worstMs = 251;
  const warned = run(over);
  assert.equal(warned.child.status, 0, warned.child.stderr);
  assert.ok(warned.child.stdout.includes('::warning::search: median 101 ms (budget 100 ms), worst 251 ms (budget 250 ms)'));
  assert.equal(warned.child.stdout.match(/::warning::/gu).length, 1, 'one named warning covers that action’s exceeded values');
  assert.ok(!warned.child.stdout.includes('::warning::idleWithLiveWrites'));

  const unknown = report();
  unknown.actions.push({ name: 'unbudgetedAction', medianMs: 1, worstMs: 1 });
  const noBudget = run(unknown);
  assert.equal(noBudget.child.status, 1);
  assert.match(noBudget.child.stderr, /unbudgetedAction.*has no budget entry/u);
  const missing = report();
  missing.actions = missing.actions.filter(action => action.name !== 'switchProject');
  const noMeasurement = run(missing);
  assert.equal(noMeasurement.child.status, 1);
  assert.match(noMeasurement.child.stderr, /budget entry switchProject has no measured action/u);
  assert.ok(readFileSync(join(noMeasurement.outputDirectory, 'performance.md'), 'utf8').includes('Report validation: invalid.'));
  assert.ok(readFileSync(join(noMeasurement.outputDirectory, 'performance.md'), 'utf8').includes('budget entry switchProject has no measured action'));

  for (const mutate of [
    value => { value.actions.push({ ...value.actions[0] }); },
    value => { value.actions[0].medianMs = '100'; },
    value => { value.actions[0].worstMs = -1; },
    value => { value.actions[0].worstMs = 99; },
    value => { value.projects = 1; },
    value => { value.size = 150; },
    value => { value.actions.find(action => action.name === 'idleWithLiveWrites').samples[0].renderedAtMs = []; },
  ]) {
    const malformed = report(); mutate(malformed);
    assert.equal(run(malformed).child.status, 1, 'malformed or incomplete measurement evidence cannot pass');
  }
  const zero = report(); zero.actions[0].medianMs = 0; zero.actions[0].worstMs = 0;
  assert.equal(run(zero).child.status, 0, 'a measured zero is distinct from missing evidence');

  // The configuration reader also fails closed if its declared budget registry is incomplete.
  const { evaluatePerfBudgets, PERF_BUDGETS } = await import('../../index.js');
  const incomplete = { ...PERF_BUDGETS }; delete incomplete.search;
  assert.match(evaluatePerfBudgets(report(), incomplete).errors.join('\n'), /search.*has no budget entry/u);
  const extra = { ...PERF_BUDGETS, absentMeasurement: { medianMs: 100, worstMs: 250 } };
  assert.match(evaluatePerfBudgets(report(), extra).errors.join('\n'), /absentMeasurement.*has no measured action/u);
});

test('main CI saves the eight-project performance report outside the gate [N40,C7]', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/gate.yml'), 'utf8');
  const perf = workflow.match(/\n  perf:\n([\s\S]*)$/u)?.[1];
  assert.ok(perf, 'performance is its own job beside the gate’s matrix jobs');
  assert.match(perf, /if: github\.ref == 'refs\/heads\/main' && github\.event_name != 'pull_request'/u);
  assert.match(perf, /runs-on: ubuntu-latest/u);
  assert.match(perf, /--size 3000 --projects 8 --runs 5 --idle 30 --live-every 5/u);
  assert.match(perf, /node packages\/gate\/src\/io\/check\/budgets\.js artifacts\/performance\/harness-output\.txt artifacts\/performance/u);
  assert.match(perf, /actions\/upload-artifact@v4\n\s+if: always\(\)/u);
  assert.match(perf, /path: artifacts\/performance\//u);
  assert.ok(!/npm (?:test|run gate)|node (?:packages\/gate|apps\/cli)\/src\/io\/run\/tests\.js/u.test(perf), 'the large observation runs separately from the gate’s tests');
});
