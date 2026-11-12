/** @pullboard-test-input packages/codemap/src/io/cell/scripts/lints.js packages/codemap/src/io/cells/scripts/plan.js packages/codemap/data/baselines/lints/index.json */
/** @pullboard-test-input ** */
/** Private real-file fixtures prove falling cell debt without moving any repository source [C7,CD64]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cellLintFiles } from '../../codemap/index.js';
import { readCellLintBaseline } from '../../codemap/index.js';
import { storedCellLintFiles } from '../../codemap/index.js';
import { writeCellLintBaseline } from '../../codemap/index.js';
import { planCellLintBaseline } from '../../codemap/index.js';
import { CELL_METRICS } from '../../codemap/index.js';
import { cellLintBaseline } from '../../codemap/index.js';
import { cellLintGrowth } from '../../codemap/index.js';
import { lowerCellLintBaseline } from '../../codemap/index.js';
import { runFixtureChild } from '../../../apps/cli/tests/fixtures/child.js';
import { fixture as planFixture } from '../../landing/tests/fixtures/plan.js';
import { importsIn } from '../../gate/index.js';
import { commonJsIn } from '../../gate/index.js';
import { runFixtureGit } from '../../../apps/cli/tests/fixtures/child.js';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { cellLintReport } from '../../codemap/index.js';
/** Create actual files and an explicit root import map; no source modules execute during reports. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-cell-lints-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => runFixtureGit(args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Cell fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Cell fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
  git('init', '-q', '-b', 'main');
  /** Write one private source or asset beneath this fixture. */
  function put(file, source) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source); }
  /** Remove only the named private fixture entity. */
  function remove(file) { rmSync(join(root, file), { recursive: true, force: true }); }
  put('package.json', JSON.stringify({ type: 'module', imports: { '#*': './packages/*/index.js', '#*.js': './packages/*.js' } }));
  put('apps/demo/index.js', "import { value } from '#sample'; console.log(value);\n");
  put('packages/sample/index.js', 'export const value = 1;\n');
  return { root, put, remove, git, report: () => cellLintReport(root, { importsIn, commonJsIn }) };
}

const BIN = fileURLToPath(new URL('../../codemap/src/io/cell/scripts/lints.js', import.meta.url));
const PLAN_BIN = fileURLToPath(new URL('../../codemap/src/io/cells/scripts/plan.js', import.meta.url));
const TRANSITION_FILE = 'packages/codemap/data/plan/transition.json';
/** Build a report-shaped value for exact identity-collision controls without filesystem side effects. */
function identityReport(pathMap, { boundaries = [], unreachableExports = [] } = {}) {
  const selected = { boundaries, unreachableExports };
  const metrics = Object.fromEntries(CELL_METRICS.map(metric => {
    const findings = selected[metric] ?? [];
    return [metric, { count: findings.reduce((sum, finding) => sum + finding.count, 0), findings }];
  }));
  return { pathMap, metrics };
}

const FAMILIES = [
  { name: 'boundaries', rise: box => box.put('apps/demo/index.js', "import { value } from '../../packages/sample/index.js'; console.log(value);\n"), fall: box => box.put('apps/demo/index.js', "import { value } from '#sample'; console.log(value);\n") },
  { name: 'cycles', rise: box => { box.put('packages/sample/index.js', "import '#other'; export const value = 1;\n"); box.put('packages/other/index.js', "import '#sample';\n"); }, fall: box => box.put('packages/other/index.js', 'void 0;\n') },
  { name: 'shims', rise: box => box.put('src/old.js', "export { value } from '../packages/sample/index.js';\n"), fall: box => box.remove('src/old.js') },
  { name: 'legacySource', rise: box => box.put('src/legacy.js', 'void 0;\n'), fall: box => box.remove('src/legacy.js') },
  { name: 'fileSize', rise: box => box.put('packages/sample/index.js', 'export const value = 1;\n' + '\n'.repeat(1501)), fall: box => box.put('packages/sample/index.js', 'export const value = 1;\n') },
  { name: 'strays', rise: box => box.put('unexpected.js', 'void 0;\n'), fall: box => box.remove('unexpected.js') },
  { name: 'documents', rise: box => box.put('packages/sample/src/core/note.md', '# Duplicate description\n'), fall: box => box.remove('packages/sample/src/core/note.md') },
  { name: 'unknown', rise: box => box.put('packages/sample/src/core/loader.js', 'import(process.env.UNKNOWN_TARGET);\n'), fall: box => box.remove('packages/sample/src/core/loader.js') },
  { name: 'unreachablePackages', rise: box => box.put('packages/orphan/index.js', 'void 0;\n'), fall: box => box.remove('packages/orphan') },
  { name: 'unreachable', rise: box => box.put('packages/sample/src/core/orphan.js', 'void 0;\n'), fall: box => box.remove('packages/sample/src/core/orphan.js') },
];
for (const family of FAMILIES) test(`cell ${family.name} debt refuses a rise and explicitly records a fall [C7,CD64]`, t => {
  const box = fixture(t), before = box.report(), baseline = cellLintBaseline(before);
  family.rise(box);
  const raised = box.report();
  assert.ok(raised.metrics[family.name].count > before.metrics[family.name].count);
  assert.ok(cellLintGrowth(raised, baseline).some(row => row.metric === family.name));
  assert.throws(() => lowerCellLintBaseline(raised, baseline), { code: 'CELL_LINT_ROSE' });
  const acceptedDebt = cellLintBaseline(raised), immutable = JSON.stringify(acceptedDebt);
  family.fall(box);
  const lowered = lowerCellLintBaseline(box.report(), acceptedDebt);
  assert.ok(lowered.metrics[family.name].count < acceptedDebt.metrics[family.name].count);
  assert.equal(JSON.stringify(acceptedDebt), immutable, 'only the returned snapshot changes');
});

test('a named unused export in an already reached file creates distinct falling debt [C7,CD62]', t => {
  const box = fixture(t), baseline = cellLintBaseline(box.report());
  box.put('packages/sample/index.js', 'export const value = 1, unused = 2;\n');
  const raised = box.report();
  assert.ok(raised.metrics.unreachableExports.findings.some(row => row.key === 'packages/sample/index.js#unused'));
  assert.ok(cellLintGrowth(raised, baseline).some(row => row.metric === 'unreachableExports'));
  const debt = cellLintBaseline(raised);
  box.put('apps/demo/index.js', "import { value, unused as used } from '#sample'; console.log(value, used);\n");
  const lowered = lowerCellLintBaseline(box.report(), debt);
  assert.equal(lowered.metrics.unreachableExports.count, 0);
  box.put('apps/demo/index.js', "import { value } from '#sample'; console.log(value);\n");
  box.put('packages/sample/index.js', 'export const value = 1;\n');
  assert.equal(lowerCellLintBaseline(box.report(), debt).metrics.unreachableExports.count, 0, 'removing the unused export also lowers the same debt');
});

test('named and star re-exports propagate only the particular exports reached by an app [C7,CD62]', t => {
  const box = fixture(t);
  box.put('packages/sample/index.js', "export { value } from './src/core/values.js'; export * from './src/core/extra.js';\n");
  box.put('packages/sample/src/core/values.js', 'export const value = 1; export const unused = 2;\n');
  box.put('packages/sample/src/core/extra.js', 'export const extra = 3;\n');
  const baseline = cellLintBaseline(box.report());
  assert.ok(baseline.metrics.unreachableExports.allowances['packages/sample/src/core/values.js#unused']);
  assert.ok(baseline.metrics.unreachableExports.allowances['packages/sample/index.js#extra']);
  box.put('apps/demo/index.js', "import { value, extra } from '#sample'; console.log(value, extra);\n");
  const lowered = lowerCellLintBaseline(box.report(), baseline);
  assert.ok(lowered.metrics.unreachableExports.count < baseline.metrics.unreachableExports.count);
  assert.ok(lowered.metrics.unreachableExports.allowances['packages/sample/src/core/values.js#unused']);
});

test('namespace members and namespace re-exports retain per-export unknown debt for opaque uses [C7,CD62]', t => {
  const box = fixture(t);
  box.put('packages/sample/index.js', "export * as api from './src/core/values.js';\n");
  box.put('packages/sample/src/core/values.js', 'export const used = 1; export const unused = 2;\n');
  box.put('apps/demo/index.js', "import { api } from '#sample'; console.log(api.used);\n");
  let report = box.report();
  assert.ok(!report.metrics.unreachableExports.findings.some(row => row.key.endsWith('#used')));
  assert.ok(report.metrics.unreachableExports.findings.some(row => row.key.endsWith('#unused')));
  box.put('apps/demo/index.js', "import * as api from '#sample'; consume(api);\n");
  report = box.report();
  assert.ok(report.metrics.unreachableExports.findings.some(row => row.key === 'packages/sample/index.js#api' && row.detail.includes('opaque')));
  const before = cellLintBaseline(report);
  box.put('packages/sample/src/core/values.js', 'export const used = 1; export const unused = 2; export const added = 3;\n');
  assert.ok(cellLintGrowth(box.report(), before).some(row => row.key.endsWith('#added')));
});

test('tests and fixture strings never seed app reach; unknown loaders and missing inputs remain named debt [C7,CD62]', t => {
  const box = fixture(t);
  box.put('packages/sample/src/core/alone.js', 'export const alone = 1;\n');
  box.put('packages/sample/tests/alone.test.js', "import { alone } from '../src/core/alone.js'; console.log(alone);\n");
  box.put('packages/sample/src/core/opaque.js', "import(process.env.COMPUTED); import './missing.js'; const text = `import '#sample'; export const fake = 1;`;\n");
  const report = box.report();
  assert.ok(report.metrics.unreachable.findings.some(row => row.key.endsWith('/alone.js')));
  assert.ok(report.metrics.unreachableExports.findings.some(row => row.key.endsWith('#alone')));
  assert.ok(report.unknown.some(row => row.reason.includes('computed')));
  assert.ok(report.unknown.some(row => row.reason.includes('missing import target')));
  assert.ok(!report.metrics.unreachableExports.findings.some(row => row.key.endsWith('#fake')));
});

test('report is read-only, initialization is explicit and check/update cannot raise or offset a finding [C7,CD64]', t => {
  const box = fixture(t), run = (mode, root = box.root) => runFixtureChild(process.execPath, [BIN, mode, root], { encoding: 'utf8', maxBuffer: 256 * 1024 ** 2 });
  box.put('path-map.json', JSON.stringify({ 'src/previous.js': 'packages/sample/index.js' }));
  box.git('add', '-A'); box.git('commit', '-qm', 'test: accepted first package migration');
  const first = run('--report'); assert.equal(first.status, 0, first.stderr);
  assert.throws(() => readFileSync(join(box.root, 'packages/codemap/data/baselines/lints/index.json')), { code: 'ENOENT' });
  assert.equal(run('--init').status, 0);
  const before = readFileSync(join(box.root, 'packages/codemap/data/baselines/lints/index.json'), 'utf8');
  assert.equal(run('--report').status, 0);
  assert.equal(readFileSync(join(box.root, 'packages/codemap/data/baselines/lints/index.json'), 'utf8'), before);
  assert.notEqual(run('--init').status, 0);
  box.put('stray.js', 'void 0;\n');
  assert.notEqual(run('--check').status, 0);
  assert.notEqual(run('--update').status, 0);
  assert.equal(readFileSync(join(box.root, 'packages/codemap/data/baselines/lints/index.json'), 'utf8'), before);
  const debt = cellLintBaseline(box.report());
  box.remove('stray.js'); box.put('another.js', 'void 0;\n');
  assert.ok(cellLintGrowth(box.report(), debt).some(row => row.key === 'another.js'));
  // The committed baseline stays hash-bound: this repository's index binds its shards, and a shard edited without a rebind fails --check [C7,CD64].
  assert.equal(run('--report', fileURLToPath(new URL('../../../', import.meta.url))).status, 0, 'the real index.json binds boundaries-012 and strays-001');
  assert.doesNotMatch(run('--check').stderr, /CELL_BASELINE/u, 'a bound baseline is never refused as unbound');
  const index = JSON.parse(readFileSync(join(box.root, 'packages/codemap/data/baselines/lints/index.json'), 'utf8')), shard = join(box.root, index.metrics.strays.shards[0].file);
  appendFileSync(shard, ' ');
  const unbound = run('--check');
  assert.notEqual(unbound.status, 0);
  assert.match(unbound.stderr, /CELL_BASELINE/u, 'a shard edited without a rebind is refused by --check');
});


test('Git ignored transient files do not change reports while tracked ignored strays still count [C7,CD61]', t => {
  const box = fixture(t);
  box.put('.gitignore', 'work/\ncoverage/\n*.log\n');
  const before = box.report();
  box.put('work/machine.js', 'throw new Error("must not execute");\n');
  box.put('coverage/data.js', 'not valid JavaScript');
  box.put('ignored.log', 'transient');
  assert.deepEqual(box.report(), before);
  box.git('add', '-f', 'work/machine.js');
  const after = box.report();
  assert.ok(after.metrics.strays.findings.some(row => row.key === 'work/machine.js'));
});

test('a committed src-to-cell path map preserves existing debt identities while genuine migration lowers counts [C7,CD60,CD64]', t => {
  const box = fixture(t);
  box.remove('packages/sample');
  box.put('src/value.js', 'export const value = 1; export const unused = 2;\n' + '\n'.repeat(505));
  box.put('apps/demo/index.js', "import { value } from '../../src/value.js'; console.log(value);\n");
  box.git('add', '-A'); box.git('commit', '-qm', 'test: actual legacy source');
  const before = box.report(), baseline = cellLintBaseline(before);
  box.remove('src/value.js');
  box.put('packages/sample/index.js', 'export const value = 1; export const unused = 2;\n' + '\n'.repeat(502));
  box.put('apps/demo/index.js', "import { value } from '#sample'; console.log(value);\n");
  box.put('path-map.json', JSON.stringify({ 'src/value.js': 'packages/sample/index.js' }));
  box.git('add', '-A'); box.git('commit', '-qm', 'test: accepted path-mapped migration');
  const after = box.report();
  assert.ok(after.metrics.legacySource.count < before.metrics.legacySource.count);
  assert.ok(after.metrics.boundaries.count < before.metrics.boundaries.count);
  assert.ok(after.metrics.fileSize.count < before.metrics.fileSize.count);
  assert.deepEqual(cellLintGrowth(after, baseline), []);
  box.put('packages/sample/index.js', 'export const value = 1; export const unused = 2; export const newlyUnused = 3;\n');
  assert.ok(cellLintGrowth(box.report(), baseline).some(row => row.metric === 'unreachableExports'
    && row.key === 'packages/sample/index.js#newlyUnused'));
});

test('normalized aliases preserve collision growth and keep unrelated identities separate [C7,CD64]', () => {
  const map = { 'src/legacy-edge.js': 'packages/sample/index.js', 'src/legacy.js': 'packages/sample/index.js' };
  const before = identityReport(map, {
    boundaries: [{ key: 'apps/demo/index.js->src/legacy-edge.js', count: 1 }],
    unreachableExports: [{ key: 'src/legacy.js#unused', count: 1 }],
  });
  const snapshot = cellLintBaseline(before);
  assert.deepEqual(cellLintGrowth(before, snapshot), [], 'a normalized generation consumes no debt twice');

  const duplicate = identityReport(map, {
    boundaries: [
      { key: 'apps/demo/index.js->src/legacy-edge.js', count: 1 },
      { key: 'apps/demo/index.js->packages/sample/index.js', count: 1 },
    ],
    unreachableExports: [
      { key: 'src/legacy.js#unused', count: 1 },
      { key: 'packages/sample/index.js#unused', count: 1 },
    ],
  });
  const duplicateGrowth = cellLintGrowth(duplicate, snapshot);
  assert.ok(duplicateGrowth.some(row => row.metric === 'boundaries'
    && row.key === 'apps/demo/index.js->packages/sample/index.js' && row.actual === 2 && row.allowed === 1));
  assert.ok(duplicateGrowth.some(row => row.metric === 'unreachableExports'
    && row.key === 'packages/sample/index.js#unused' && row.actual === 2 && row.allowed === 1));
  assert.equal(cellLintBaseline(duplicate).metrics.boundaries.count, 2, 'normalization leaves raw boundary totals intact');
  assert.equal(cellLintBaseline(duplicate).metrics.unreachableExports.count, 2, 'normalization leaves raw export totals intact');

  const unrelated = identityReport(map, {
    boundaries: [{ key: 'apps/demo/index.js->packages/other/index.js', count: 1 }],
    unreachableExports: [{ key: 'packages/sample/index.js#newName', count: 1 }],
  });
  const unrelatedGrowth = cellLintGrowth(unrelated, snapshot);
  assert.ok(unrelatedGrowth.some(row => row.metric === 'boundaries'
    && row.key === 'apps/demo/index.js->packages/other/index.js' && row.allowed === 0));
  assert.ok(unrelatedGrowth.some(row => row.metric === 'unreachableExports'
    && row.key === 'packages/sample/index.js#newName' && row.allowed === 0));
});

test('sharded committed path maps activate ratchets while absent maps remain advisory [C7]', t => {
  const box = fixture(t), run = mode => runFixtureChild(process.execPath, [BIN, mode, box.root], { encoding: 'utf8' });
  const before = box.report(), baseline = cellLintBaseline(before);
  assert.equal(before.transition.active, true, 'a repository with no committed map stays in the advisory transition');
  box.put('src/advisory-rise.js', 'export const value = 1;\n');
  assert.ok(cellLintGrowth(box.report(), baseline).some(row => row.key === 'src/advisory-rise.js' && row.advisory));

  box.put('packages/codemap/data/plan/path-map/git.json', JSON.stringify({ 'src/previous.js': 'packages/sample/index.js' }));
  box.git('add', '-A'); box.git('commit', '-qm', 'test: accept a sharded package migration map');
  const moved = box.report();
  assert.equal(moved.transition.active, false, 'the committed shard closes the transition without a root map');
  assert.deepEqual(moved.transition.witness, ['src/previous.js', 'packages/sample/index.js']);
  assert.ok(!moved.metrics.strays.findings.some(row => row.key === 'packages/codemap/data/plan/path-map/git.json'), 'a path-map shard is tooling metadata, not a stray');
  assert.ok(!moved.metrics.unreachable.findings.some(row => row.key === 'packages/codemap/data/plan/path-map/git.json'), 'a path-map shard is not an application module');
  const strictPlan = planCellLintBaseline(moved), strictBaseline = strictPlan.baseline;
  writeCellLintBaseline(box.root, strictBaseline, {
    initialize: true,
    verify: () => JSON.stringify(cellLintBaseline(box.report())) === JSON.stringify(strictBaseline),
  });
  assert.deepEqual(cellLintGrowth(moved, strictBaseline), [], 'a same-generation snapshot does not remap its own debt twice');
  box.put('src/strict-rise.js', 'export const value = 2;\n');
  const strict = box.report(), rise = cellLintGrowth(strict, strictBaseline);
  assert.ok(rise.some(row => row.key === 'src/strict-rise.js' && !row.advisory), 'post-migration source debt is enforced');
  assert.notEqual(run('--check').status, 0, 'the actual CLI refuses a rise with only a committed shard map');
});

test('a committed #1781 marker makes new debt advisory until #1770 deletes it, but never cycles or the hard cap [C7,CD64]', t => {
  const box = fixture(t), run = mode => runFixtureChild(process.execPath, [BIN, mode, box.root], { encoding: 'utf8' });
  box.put('packages/codemap/data/plan/path-map/sample.json', JSON.stringify({ 'src/previous.js': 'packages/sample/index.js' }));
  box.git('add', '-A'); box.git('commit', '-qm', 'test: accept a package migration');
  const baseline = planCellLintBaseline(box.report()).baseline;
  writeCellLintBaseline(box.root, baseline, {
    initialize: true,
    verify: () => JSON.stringify(cellLintBaseline(box.report())) === JSON.stringify(baseline),
  });
  assert.equal(box.report().transition.active, false, 'the committed package map has already closed the earlier transition');
  box.put(TRANSITION_FILE, '{"version":1,"deleteItem":1770}\n');
  assert.equal(box.report().transition.active, false, 'an uncommitted marker cannot grant advisory growth');
  box.git('add', '-A'); box.git('commit', '-qm', 'test: commit the named transition marker');
  const marked = box.report();
  assert.deepEqual([marked.transition.item, marked.transition.until, marked.transition.active], [1781, 1770, true]);
  assert.ok(!marked.metrics.strays.findings.some(row => row.key === TRANSITION_FILE));
  assert.ok(!marked.metrics.unreachable.findings.some(row => row.key === TRANSITION_FILE));
  box.put('apps/demo/index.js', "import { value } from '../../packages/sample/index.js'; console.log(value);\n");
  const advisory = cellLintGrowth(box.report(), baseline);
  assert.ok(advisory.some(row => row.metric === 'boundaries' && row.key === 'apps/demo/index.js->packages/sample/index.js'
    && row.advisory && row.item === 1781 && row.until === 1770));
  assert.deepEqual(cellLintGrowth(box.report(), baseline, { enforcedOnly: true }), []);
  const checked = run('--check');
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stderr, /advisory item #1781 until #1770: boundaries:apps\/demo\/index\.js->packages\/sample\/index\.js/u);
  assert.throws(() => lowerCellLintBaseline(box.report(), baseline), { code: 'CELL_LINT_ROSE' }, 'advisory rises cannot raise the ratchet');
  box.put('packages/sample/index.js', "import '#other'; export const value = 1;\n" + '\n'.repeat(1500));
  box.put('packages/other/index.js', "import '#sample';\n");
  const strict = cellLintGrowth(box.report(), baseline, { enforcedOnly: true });
  assert.ok(strict.some(row => row.metric === 'cycles' && !row.advisory));
  assert.ok(strict.some(row => row.metric === 'fileSize' && row.key === 'packages/sample/index.js' && !row.advisory));
  assert.notEqual(run('--check').status, 0, 'the actual CLI refuses a cycle and over-1500-line file with the marker');
  box.put('packages/sample/index.js', 'export const value = 1;\n');
  box.remove('packages/other');
  box.remove(TRANSITION_FILE);
  box.put('apps/demo/index.js', "import { value } from '#sample'; console.log(value);\n");
  box.git('add', '-A'); box.git('commit', '-qm', 'test: main deletes the marker after the migration');
  // The candidate's rise stays uncommitted: --check compares it with main counted now [C7].
  box.put('apps/demo/index.js', "import { value } from '../../packages/sample/index.js'; console.log(value);\n");
  assert.equal(box.report().transition.active, false);
  assert.ok(cellLintGrowth(box.report(), baseline, { enforcedOnly: true }).some(row => row.metric === 'boundaries' && !row.advisory));
  assert.notEqual(run('--check').status, 0, 'deleting the marker restores strict identity growth');
  box.put(TRANSITION_FILE, '{"version":1,"deleteItem":1771}\n');
  box.git('add', '-A'); box.git('commit', '-qm', 'test: malformed marker');
  const malformed = box.report();
  assert.equal(malformed.transition.active, false, 'another deletion item grants no transition');
  assert.ok(malformed.metrics.unknown.findings.some(row => row.key.includes(TRANSITION_FILE)), 'invalid marker remains named debt');
});

test('the actual plan --write preserves only the named transition marker beside generated shards [C7,CD64]', t => {
  const { root, put } = planFixture(t);
  const bytes = '{"version":1,"deleteItem":1770}\n';
  put(TRANSITION_FILE, bytes);
  put('packages/codemap/data/plan/stale.json', '{}\n');
  const result = runFixtureChild(process.execPath, [PLAN_BIN, '--write'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, TRANSITION_FILE), 'utf8'), bytes, 'regeneration preserves the exact marker bytes');
  assert.throws(() => readFileSync(join(root, 'packages/codemap/data/plan/stale.json')), { code: 'ENOENT' }, 'unrelated metadata is not exempted');
});

test('property keys and member spellings never prove imported binding reads; shorthand and calls do [C7,CD62]', t => {
  const box = fixture(t);
  box.put('packages/sample/index.js', 'export function hidden() { return 1; }\n');
  const debt = () => box.report().metrics.unreachableExports.findings.filter(row => row.key === 'packages/sample/index.js#hidden');
  box.put('apps/demo/index.js', "import { hidden } from '#sample'; const obj = { hidden: 1 }; console.log(obj.hidden);\n");
  assert.equal(debt().length, 1, 'keys and member names are not references to the imported binding');
  box.put('apps/demo/index.js', "import { hidden } from '#sample'; if (true) /hidden/.test('text');\n");
  assert.equal(debt().length, 1, 'regular-expression spelling after a condition is not a binding read');
  const before = cellLintBaseline(box.report());
  box.put('apps/demo/index.js', "import { hidden } from '#sample'; console.log({ hidden });\n");
  assert.equal(debt().length, 0, 'object shorthand really reads the imported value');
  assert.equal(lowerCellLintBaseline(box.report(), before).metrics.unreachableExports.count, 0);
  box.put('apps/demo/index.js', "import { hidden } from '#sample'; hidden();\n");
  assert.equal(debt().length, 0, 'a real call reads the imported function');
  box.put('apps/demo/index.js', "import { hidden } from '#sample'; const obj = {}; ({ hidden } = obj);\n");
  assert.equal(debt().length, 1, 'an assignment target does not prove a value read');
});

test('shadowed named and namespace bindings retain individual opaque export debt [C7,CD62]', t => {
  const box = fixture(t);
  box.put('packages/sample/index.js', 'export const hidden = 1; export const extra = 2;\n');
  box.put('apps/demo/index.js', "import { hidden } from '#sample'; function f(hidden) { return hidden; } console.log(f(1));\n");
  let report = box.report();
  assert.ok(report.metrics.unreachableExports.findings.some(row => row.key.endsWith('#hidden') && row.detail.includes('opaque')));
  assert.ok(report.unknown.some(row => row.reason.includes('shadow binding')));
  box.put('apps/demo/index.js', "import * as api from '#sample'; function f(api) { return api.hidden; } console.log(f({ hidden: 1 }));\n");
  report = box.report();
  for (const name of ['hidden', 'extra']) assert.ok(report.metrics.unreachableExports.findings.some(row => row.key.endsWith('#' + name) && row.detail.includes('opaque')));
  box.put('apps/demo/index.js', "import * as api from '#sample'; console.log(api.hidden);\n");
  report = box.report();
  assert.ok(!report.metrics.unreachableExports.findings.some(row => row.key.endsWith('#hidden')));
  assert.ok(report.metrics.unreachableExports.findings.some(row => row.key.endsWith('#extra')));
});

test('a package containing only tests is distinct package debt while an app-reached front door is live [C7,CD62]', t => {
  const box = fixture(t);
  assert.equal(box.report().metrics.unreachablePackages.count, 0, 'the real app import reaches the initial package front door');
  box.put('packages/orphan/tests/only.test.js', "import { value } from '#sample'; console.log(value);\n");
  const orphan = box.report(), debt = cellLintBaseline(orphan);
  assert.deepEqual(orphan.metrics.unreachablePackages.findings.map(row => row.key), ['packages/orphan']);
  assert.ok(!orphan.metrics.unreachable.findings.some(row => row.key.endsWith('/only.test.js')), 'test modules are not production reach roots or production file debt');
  box.put('packages/orphan/index.js', 'export const reached = 1;\n');
  box.put('apps/demo/index.js', "import { value } from '#sample'; import { reached } from '#orphan'; console.log(value, reached);\n");
  assert.equal(lowerCellLintBaseline(box.report(), debt).metrics.unreachablePackages.count, 0, 'real app reach lowers package debt');
});

test('bounded hash-bound baseline shards count their own files and refuse missing, partial or failed generations [C7,CD64]', t => {
  const box = fixture(t);
  for (let index = 0; index < 405; index++) box.put(`stray-${index}.txt`, 'actual private file\n');
  const plan = planCellLintBaseline(box.report()), files = cellLintFiles(plan.baseline);
  assert.ok([...files.keys()].filter(file => file.includes('/strays-')).length > 1);
  for (const bytes of files.values()) assert.ok(bytes.split('\n').length - 1 < 500);
  writeCellLintBaseline(box.root, plan.baseline, { initialize: true, verify: () => JSON.stringify(cellLintBaseline(box.report())) === JSON.stringify(plan.baseline) });
  assert.deepEqual(JSON.parse(JSON.stringify(readCellLintBaseline(box.root))), JSON.parse(JSON.stringify(plan.baseline)));
  for (const file of files.keys()) {
    assert.ok(plan.baseline.metrics.strays.allowances[file], 'metadata is ordinary stray debt, never exempt');
    assert.ok(plan.baseline.metrics.unreachable.allowances[file], 'metadata is an ordinary production bin file');
  }
  const shard = [...files.keys()].find(file => file.includes('/strays-')), original = files.get(shard);
  box.remove(shard);
  assert.throws(() => readCellLintBaseline(box.root), { code: 'CELL_BASELINE' });
  box.put(shard, original.slice(0, -5));
  assert.throws(() => readCellLintBaseline(box.root), { code: 'CELL_BASELINE' });
  box.put(shard, original.replace('actual-impossible-key', 'other-impossible-key') + ' ');
  assert.throws(() => readCellLintBaseline(box.root), { code: 'CELL_BASELINE' });
  box.put(shard, original);
  const before = storedCellLintFiles(box.root);
  assert.throws(() => writeCellLintBaseline(box.root, plan.baseline, { verify: () => false }), { code: 'CELL_BASELINE' });
  assert.deepEqual(storedCellLintFiles(box.root), before, 'a refused publication restores the exact prior bytes');
});


test('transitional roots follow real package CLI/browser declarations and never arbitrary fixture HTML [C7,CD62]', t => {
  const box = fixture(t);
  box.remove('apps');
  box.put('package.json', JSON.stringify({ type: 'module', bin: { real: 'bin/real.js' }, browser: 'web/index.html', imports: { '#*': './packages/*/index.js' } }));
  box.put('bin/real.js', "import { value } from '#sample'; console.log(value);\n");
  box.put('bin/not-an-entry.js', 'export const alone = 1;\n');
  box.put('web/index.html', '<!doctype html><script type="module" src="./start.js"></script><template><script src="../proof/fixture-only.js"></script></template><textarea><script src="../proof/fixture-only.js"></script></textarea><script type="application/json" src="../proof/fixture-only.js"></script>\n');
  box.put('web/start.js', "import { displayed } from '#browser'; console.log(displayed);\n");
  box.put('packages/browser/index.js', 'export const displayed = 1; export const neverUsed = 2;\n');
  box.put('proof/sample.html', '<!doctype html><script src="./fixture-only.js"></script>\n');
  box.put('proof/fixture-only.js', "import { neverUsed } from '#browser'; console.log(neverUsed);\n");
  const report = box.report();
  assert.equal(report.rootMode, 'transitional');
  assert.deepEqual(report.roots, ['bin/real.js', 'web/index.html', 'web/start.js']);
  assert.ok(!report.metrics.unreachableExports.findings.some(row => row.key.endsWith('#value') || row.key.endsWith('#displayed')));
  assert.ok(report.metrics.unreachableExports.findings.some(row => row.key.endsWith('#neverUsed')));
  assert.ok(report.metrics.unreachable.findings.some(row => row.key === 'bin/not-an-entry.js'));
});

test('real apps replace transitional roots without letting test programs seed application reach [C7,CD62]', t => {
  const box = fixture(t);
  box.remove('apps');
  box.put('package.json', JSON.stringify({ type: 'module', bin: 'bin/old.js', browser: 'test/fixture.html', imports: { '#*': './packages/*/index.js' } }));
  box.put('bin/old.js', "import { value } from '#sample'; console.log(value);\n");
  box.put('test/fixture.html', '<!doctype html><script src="./fixture.js"></script>\n');
  box.put('test/fixture.js', 'throw new Error("must never run or root");\n');
  let report = box.report();
  assert.deepEqual(report.roots, ['bin/old.js']);
  assert.ok(report.unknown.some(row => row.specifier === 'test/fixture.html'));
  box.put('apps/live/index.js', 'console.log("actual app");\n');
  box.put('apps/live/tests/only.test.js', "import { value } from '#sample'; console.log(value);\n");
  report = box.report();
  assert.equal(report.rootMode, 'apps');
  assert.deepEqual(report.roots, ['apps/live/index.js']);
  assert.ok(report.metrics.unreachable.findings.some(row => row.key === 'bin/old.js'));
  assert.ok(report.metrics.unreachableExports.findings.some(row => row.key.endsWith('#value')));
  box.put('apps/live/index.js', "import { value } from '#sample'; console.log(value);\n");
  assert.ok(!box.report().metrics.unreachableExports.findings.some(row => row.key.endsWith('#value')));
});

test('audited browser serving roots require real entry URLs, not every served browser asset or embedded example [C7,CD62]', t => {
  const box = fixture(t);
  box.remove('apps');
  box.put('apps/relay/src/io/deploy/browser-page.js', "import { readFileSync } from 'node:fs';\nconst assets = new Map([['/relay/client.js', ['text/javascript', readFileSync(new URL('./browser-client.js', import.meta.url), 'utf8')]], ['/service-worker.js', ['text/javascript', readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8')]], ['/relay/not-an-entry.js', ['text/javascript', readFileSync(new URL('./not-an-entry.js', import.meta.url), 'utf8')]]]);\nconst options = { transportModule: '/relay/client.js' };\nconst example = `const ignored = { transportModule: '/relay/not-an-entry.js' };`;\n''.replace('</body>', '<script src=\"/relay/generated.js\"></script>');\n");
  box.put('apps/relay/src/io/deploy/browser-client.js', "import { value } from '#sample'; console.log(value);\n");
  box.put('apps/relay/src/io/deploy/browser-install.js', "export function register(browser) { return browser.serviceWorker.register('/service-worker.js'); }\n");
  box.put('apps/relay/src/io/deploy/service-worker.js', 'console.log("worker entry");\n');
  box.put('apps/relay/src/io/deploy/not-an-entry.js', 'export const unused = 1;\n');
  const report = box.report();
  assert.deepEqual(report.roots, ['apps/relay/src/io/deploy/browser-client.js', 'apps/relay/src/io/deploy/service-worker.js']);
  assert.ok(report.metrics.unreachable.findings.some(row => row.key === 'apps/relay/src/io/deploy/not-an-entry.js'));
  assert.ok(report.unknown.some(row => row.specifier === '/relay/generated.js' && row.reason.includes('unproven')));
  assert.ok(!report.metrics.unreachableExports.findings.some(row => row.key.endsWith('#value')));
});

test('baseline initialization preserves unowned colliding shard bytes and leaves its descriptor absent [C7,CD64]', t => {
  const box = fixture(t), plan = planCellLintBaseline(box.report()), files = cellLintFiles(plan.baseline);
  const shard = [...files.keys()].find(file => file.includes('/strays-'));
  assert.ok(shard, 'the real planned metadata inventory has its own stray shard');
  const collision = 'packages/codemap/data/baselines/lints/strays-001.json';
  assert.equal(shard, collision, 'the real planner names its first stray shard deterministically');
  const original = Buffer.from('existing private bytes are not a baseline and must remain untouched\n');
  box.put(shard, original);
  assert.throws(() => writeCellLintBaseline(box.root, plan.baseline, { initialize: true }), { code: 'CELL_BASELINE' });
  assert.deepEqual(readFileSync(join(box.root, collision)), original, 'a rejected initial write neither overwrites nor rollback-deletes the colliding file');
  assert.throws(() => readFileSync(join(box.root, 'packages/codemap/data/baselines/lints/index.json')), { code: 'ENOENT' });
});


test('the pre-cell transition reports size, files and edges while keeping baseline updates falling-only [C7,CD64]', t => {
  const box = fixture(t), run = mode => runFixtureChild(process.execPath, [BIN, mode, box.root], { encoding: 'utf8' });
  const initial = run('--init');
  assert.equal(initial.status, 0, initial.stderr);
  const baseline = readCellLintBaseline(box.root), descriptor = readFileSync(join(box.root, 'packages/codemap/data/baselines/lints/index.json'));
  box.git('add', '-A'); box.git('commit', '-qm', 'test: establish the real pre-migration source tree');
  box.put('src/transition-reader.js', 'export const extra = 2;\n' + '\n'.repeat(505));
  box.put('test/transition-control.test.js', 'void 0;\n');
  box.put('apps/demo/index.js', "import { value } from '#sample'; import { extra } from '../../src/transition-reader.js'; console.log(value, extra);\n");
  const report = box.report();
  assert.equal(report.transition.active, true);
  const growth = cellLintGrowth(report, baseline);
  assert.ok(growth.some(row => row.metric === 'legacySource' && row.key === 'src/transition-reader.js' && row.advisory));
  assert.ok(growth.some(row => row.metric === 'strays' && row.key === 'test/transition-control.test.js' && row.advisory));
  assert.ok(growth.some(row => row.metric === 'boundaries' && row.key.endsWith('->src/transition-reader.js') && row.advisory));
  assert.ok(growth.every(row => row.advisory && row.item === 1527 && row.until === 1395));
  assert.deepEqual(cellLintGrowth(report, baseline, { enforcedOnly: true }), []);
  const checked = run('--check');
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stderr, /advisory item #1527 until #1395: legacySource:src\/transition-reader\.js/u);
  assert.match(checked.stderr, /boundaries:apps\/demo\/index\.js->src\/transition-reader\.js/u);
  assert.match(checked.stderr, /strays:test\/transition-control\.test\.js/u);
  assert.match(checked.stderr, /fileSize:src\/transition-reader\.js/u);
  const reported = run('--report');
  assert.equal(reported.status, 0, reported.stderr);
  assert.ok(JSON.parse(reported.stdout).growth.some(row => row.advisory && row.key === 'src/transition-reader.js'));
  assert.notEqual(run('--update').status, 0, 'the actual CLI refuses an advisory baseline increase');
  assert.deepEqual(readFileSync(join(box.root, 'packages/codemap/data/baselines/lints/index.json')), descriptor);
  assert.throws(() => lowerCellLintBaseline(report, baseline), { code: 'CELL_LINT_ROSE' }, 'advisory debt never raises the stored ratchet');
  box.put('path-map.json', JSON.stringify({ 'src/previous.js': 'packages/sample/index.js' }));
  assert.equal(box.report().transition.active, true, 'an uncommitted path map is not accepted source evidence');
  // Main accepts only the map; the helper change stays the uncommitted candidate --check compares with main [C7].
  box.git('add', 'path-map.json'); box.git('commit', '-qm', 'test: accepted first package migration');
  const after = box.report();
  assert.equal(after.transition.active, false, 'the exact committed package migration closes the transition');
  assert.deepEqual(after.transition.witness, ['src/previous.js', 'packages/sample/index.js']);
  assert.ok(cellLintGrowth(after, baseline, { enforcedOnly: true }).some(row => row.key === 'src/transition-reader.js' && !row.advisory));
  const strict = run('--check');
  assert.notEqual(strict.status, 0, 'the same real helper/test/import change is refused after the accepted source witness');
  assert.match(strict.stderr, /legacySource:src\/transition-reader\.js/u);
  assert.doesNotMatch(strict.stderr, /advisory item/u);
});

test('the pre-cell transition keeps real cycles strict and reports every other family [C7,CD64]', t => {
  const box = fixture(t), baseline = cellLintBaseline(box.report());
  box.put('packages/sample/index.js', "import '#other'; export const value = 1;\n");
  box.put('packages/other/index.js', "import '#sample';\n");
  box.put('src/bridge.js', "export { value } from '../packages/sample/index.js';\n");
  box.put('packages/sample/src/core/orphan.js', 'export const unused = 1;\n' + '\n'.repeat(1501));
  box.put('packages/sample/src/core/note.md', '# Fixture documentation debt\n');
  box.put('packages/sample/src/core/opaque.js', 'import(process.env.UNKNOWN_TARGET);\n');
  const report = box.report();
  assert.equal(report.transition.active, true);
  const strict = cellLintGrowth(report, baseline, { enforcedOnly: true });
  assert.ok(strict.length && strict.every(row => ['cycles', 'fileSize'].includes(row.metric) && !row.advisory));
  const reported = cellLintGrowth(report, baseline);
  for (const metric of ['shims', 'unreachable', 'unreachableExports', 'documents', 'unknown']) {
    assert.ok(reported.some(row => row.metric === metric && row.advisory), `${metric} is measured and reported`);
  }
  assert.throws(() => lowerCellLintBaseline(report, baseline), { code: 'CELL_LINT_ROSE' });
});


test('literal native worker URLs and native data reads count as reach while unused and shadowed URLs do not [C7,CD62]', t => {
  const box = fixture(t);
  box.put('apps/demo/index.js', `import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
new Worker(new URL('../../src/worker.js', import.meta.url));
readFileSync(new URL('../../src/native-harness-manifest.json', import.meta.url), 'utf8');
const baseline = new URL('../../src/flake-baseline.json', import.meta.url);
readFileSync(baseline, 'utf8');
const unused = new URL('../../src/unused.js', import.meta.url);
`);
  box.put('src/worker.js', 'void 0;\n');
  box.put('src/native-harness-manifest.json', '{"files":[]}\n');
  box.put('src/flake-baseline.json', '{}\n');
  box.put('src/unused.js', 'void 0;\n');
  const report = box.report();
  for (const file of ['src/worker.js', 'src/native-harness-manifest.json', 'src/flake-baseline.json']) {
    assert.ok(!report.metrics.unreachable.findings.some(row => row.key === file), `${file} has an actual native consumer`);
  }
  assert.ok(report.metrics.unreachable.findings.some(row => row.key === 'src/unused.js'));
  box.put('apps/demo/index.js', `import { Worker } from 'node:worker_threads';
function example(Worker) { return new Worker(new URL('../../src/worker.js', import.meta.url)); }
example(class {});
`);
  assert.ok(box.report().metrics.unreachable.findings.some(row => row.key === 'src/worker.js'), 'a shadowed worker binding is not proven to launch the file');
});

test('literal Node process worker arguments reach their file but computed and test-only input declarations stay unproven [C7,CD62]', t => {
  const box = fixture(t);
  box.put('apps/demo/index.js', `import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
spawnSync(process.execPath, [fileURLToPath(new URL('../../src/process-worker.js', import.meta.url))]);
`);
  box.put('src/process-worker.js', 'void 0;\n');
  box.put('src/only-test.json', '{}\n');
  box.put('test/reader.test.js', "import { readFileSync } from 'node:fs'; readFileSync(new URL('../src/only-test.json', import.meta.url));\n");
  const report = box.report();
  assert.ok(!report.metrics.unreachable.findings.some(row => row.key === 'src/process-worker.js'));
  assert.ok(report.metrics.unreachable.findings.some(row => row.key === 'src/only-test.json'), 'a test never seeds production data reach');
  box.put('apps/demo/index.js', `import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
function example(process) { return spawnSync(process.execPath, [fileURLToPath(new URL('../../src/process-worker.js', import.meta.url))]); }
example({ execPath: '/bin/echo' });
`);
  const shadowed = box.report();
  assert.ok(shadowed.metrics.unreachable.findings.some(row => row.key === 'src/process-worker.js'), 'a shadowed execPath is not a native Node worker');
  assert.ok(shadowed.unknown.some(row => row.file === 'apps/demo/index.js' && row.reason.includes('process')), 'the unproven process identity is disclosed');
  box.put('src/fake-process.js', "export default { execPath: '/bin/echo' };\n");
  box.put('apps/demo/index.js', `import process from '../../src/fake-process.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
spawnSync(process.execPath, [fileURLToPath(new URL('../../src/process-worker.js', import.meta.url))]);
`);
  assert.ok(box.report().metrics.unreachable.findings.some(row => row.key === 'src/process-worker.js'), 'an imported lookalike does not declare the real process');
  box.put('apps/demo/index.js', "import(process.env.UNKNOWN_WORKER);\n");
  const opaque = box.report();
  assert.ok(opaque.metrics.unreachable.findings.some(row => row.key === 'src/process-worker.js'));
  assert.ok(opaque.unknown.some(row => row.file === 'apps/demo/index.js'), 'computed input remains disclosed, not a fabricated edge');
});

for (const file of ['src/oversized.js', 'test/oversized.test.js', 'src/oversized.mjs', 'test/oversized.cjs', 'src/oversized.ts']) test(`hard file maximum stays falling-only for ${file} before and after migration [C7,CD64]`, t => {
  const box = fixture(t);
  /** Write an exact private source line count without compressing code. */
  const lines = count => box.put(file, 'void 0;\n'.repeat(count));
  lines(1500);
  const baseline = cellLintBaseline(box.report());
  lines(1501);
  const strict = cellLintGrowth(box.report(), baseline, { enforcedOnly: true });
  assert.ok(strict.some(row => row.metric === 'fileSize' && row.key === file && row.actual === 1001 && row.allowed === 1000));
  assert.throws(() => lowerCellLintBaseline(box.report(), baseline), { code: 'CELL_LINT_ROSE' });
  lines(1600);
  const debt = cellLintBaseline(box.report());
  lines(1601);
  assert.ok(cellLintGrowth(box.report(), debt, { enforcedOnly: true }).some(row => row.key === file));
  lines(1599);
  assert.deepEqual(cellLintGrowth(box.report(), debt, { enforcedOnly: true }), []);
  const lowered = lowerCellLintBaseline(box.report(), debt);
  assert.equal(lowered.metrics.fileSize.allowances[file], 1099);
  lines(1600);
  assert.ok(cellLintGrowth(box.report(), lowered, { enforcedOnly: true }).some(row => row.key === file && row.allowed === 1099));
  lines(1500);
  const edge = lowerCellLintBaseline(box.report(), lowered);
  lines(1499);
  assert.deepEqual(cellLintGrowth(box.report(), edge, { enforcedOnly: true }), []);
  box.put('path-map.json', JSON.stringify({ 'src/old.js': 'packages/sample/index.js' }));
  box.git('add', '-A'); box.git('commit', '-qm', 'test: accept the private package migration');
  assert.equal(box.report().transition.active, false);
  lines(1501);
  assert.ok(cellLintGrowth(box.report(), edge, { enforcedOnly: true }).some(row => row.key === file));
});

test('hard file cap excludes data and Markdown while preserving their advisory debt [C7]', t => {
  const box = fixture(t), baseline = cellLintBaseline(box.report());
  for (const file of ['test/golden.json', 'test/golden.txt', 'docs/guide.md']) box.put(file, '\n'.repeat(1501));
  const report = box.report();
  assert.deepEqual(cellLintGrowth(report, baseline, { enforcedOnly: true }), []);
  for (const file of ['test/golden.json', 'test/golden.txt', 'docs/guide.md']) {
    assert.ok(cellLintGrowth(report, baseline).some(row => row.metric === 'fileSize' && row.key === file && row.advisory));
  }
  assert.throws(() => lowerCellLintBaseline(report, baseline), { code: 'CELL_LINT_ROSE' });
});
