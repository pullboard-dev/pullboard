/** @pullboard-test-input ** */
import { runFixtureGit } from './fixture-child.js';
/** Private real-file fixtures prove falling cell debt without moving any repository source [C7,CD64]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cellLintFiles } from '../src/cell-lint-store.js';
import { readCellLintBaseline } from '../src/cell-lint-store.js';
import { storedCellLintFiles } from '../src/cell-lint-store.js';
import { writeCellLintBaseline } from '../src/cell-lint-store.js';
import { planCellLintBaseline } from '../src/cell-lint-baseline-plan.js';
import { cellLintReport } from '../src/cell-lints.js';
import { cellLintBaseline } from '../src/cell-lint-ratchet.js';
import { cellLintGrowth } from '../src/cell-lint-ratchet.js';
import { lowerCellLintBaseline } from '../src/cell-lint-ratchet.js';
import { runFixtureChild } from './fixture-child.js';

const BIN = fileURLToPath(new URL('../bin/cell-lints.js', import.meta.url));
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
  return { root, put, remove, git, report: () => cellLintReport(root) };
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
  const box = fixture(t), run = mode => runFixtureChild(process.execPath, [BIN, mode, box.root], { encoding: 'utf8' });
  box.put('path-map.json', JSON.stringify({ 'src/previous.js': 'packages/sample/index.js' }));
  box.git('add', '-A'); box.git('commit', '-qm', 'test: accepted first package migration');
  const first = run('--report'); assert.equal(first.status, 0, first.stderr);
  assert.throws(() => readFileSync(join(box.root, 'bin/cell-lint-baselines/index.json')), { code: 'ENOENT' });
  assert.equal(run('--init').status, 0);
  const before = readFileSync(join(box.root, 'bin/cell-lint-baselines/index.json'), 'utf8');
  assert.equal(run('--report').status, 0);
  assert.equal(readFileSync(join(box.root, 'bin/cell-lint-baselines/index.json'), 'utf8'), before);
  assert.notEqual(run('--init').status, 0);
  box.put('stray.js', 'void 0;\n');
  assert.notEqual(run('--check').status, 0);
  assert.notEqual(run('--update').status, 0);
  assert.equal(readFileSync(join(box.root, 'bin/cell-lint-baselines/index.json'), 'utf8'), before);
  const debt = cellLintBaseline(box.report());
  box.remove('stray.js'); box.put('another.js', 'void 0;\n');
  assert.ok(cellLintGrowth(box.report(), debt).some(row => row.key === 'another.js'));
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
  assert.ok(cellLintGrowth(box.report(), baseline).some(row => row.key.endsWith('#newlyUnused')));
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


test('the actual repository gate enforces strict cell debt and reports temporary named transition rises [C7,CD64]', () => {
  const root = dirname(dirname(BIN)), report = cellLintReport(root), baseline = readCellLintBaseline(root);
  const growth = cellLintGrowth(report, baseline);
  for (const row of growth.filter(row => row.advisory)) console.log(`advisory item #${row.item} until #${row.until}: ${row.metric}:${row.key}: ${row.actual} exceeds ${row.allowed}`);
  assert.deepEqual(cellLintGrowth(report, baseline, { enforcedOnly: true }), [], 'normal npm test keeps all non-transition debt strict without updating the baseline');
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
  box.put('relay/browser-page.js', "import { readFileSync } from 'node:fs';\nconst assets = new Map([['/relay/client.js', ['text/javascript', readFileSync(new URL('./browser-client.js', import.meta.url), 'utf8')]], ['/service-worker.js', ['text/javascript', readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8')]], ['/relay/not-an-entry.js', ['text/javascript', readFileSync(new URL('./not-an-entry.js', import.meta.url), 'utf8')]]]);\nconst options = { transportModule: '/relay/client.js' };\nconst example = `const ignored = { transportModule: '/relay/not-an-entry.js' };`;\n''.replace('</body>', '<script src=\"/relay/generated.js\"></script>');\n");
  box.put('relay/browser-client.js', "import { value } from '#sample'; console.log(value);\n");
  box.put('relay/browser-install.js', "export function register(browser) { return browser.serviceWorker.register('/service-worker.js'); }\n");
  box.put('relay/service-worker.js', 'console.log("worker entry");\n');
  box.put('relay/not-an-entry.js', 'export const unused = 1;\n');
  const report = box.report();
  assert.deepEqual(report.roots, ['relay/browser-client.js', 'relay/service-worker.js']);
  assert.ok(report.metrics.unreachable.findings.some(row => row.key === 'relay/not-an-entry.js'));
  assert.ok(report.unknown.some(row => row.specifier === '/relay/generated.js' && row.reason.includes('unproven')));
  assert.ok(!report.metrics.unreachableExports.findings.some(row => row.key.endsWith('#value')));
});

test('baseline initialization preserves unowned colliding shard bytes and leaves its descriptor absent [C7,CD64]', t => {
  const box = fixture(t), plan = planCellLintBaseline(box.report()), files = cellLintFiles(plan.baseline);
  const shard = [...files.keys()].find(file => file.includes('/strays-'));
  assert.ok(shard, 'the real planned metadata inventory has its own stray shard');
  const original = Buffer.from('existing private bytes are not a baseline and must remain untouched\n');
  box.put(shard, original);
  assert.throws(() => writeCellLintBaseline(box.root, plan.baseline, { initialize: true }), { code: 'CELL_BASELINE' });
  assert.deepEqual(readFileSync(join(box.root, shard)), original, 'a rejected initial write neither overwrites nor rollback-deletes the colliding file');
  assert.throws(() => readFileSync(join(box.root, 'bin/cell-lint-baselines/index.json')), { code: 'ENOENT' });
});


test('the pre-cell transition reports each permitted file and edge while keeping baseline updates falling-only [C7,CD64]', t => {
  const box = fixture(t), run = mode => runFixtureChild(process.execPath, [BIN, mode, box.root], { encoding: 'utf8' });
  const initial = run('--init');
  assert.equal(initial.status, 0, initial.stderr);
  const baseline = readCellLintBaseline(box.root), descriptor = readFileSync(join(box.root, 'bin/cell-lint-baselines/index.json'));
  box.put('src/transition-reader.js', 'export const extra = 2;\n');
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
  const reported = run('--report');
  assert.equal(reported.status, 0, reported.stderr);
  assert.ok(JSON.parse(reported.stdout).growth.some(row => row.advisory && row.key === 'src/transition-reader.js'));
  assert.notEqual(run('--update').status, 0, 'the actual CLI refuses an advisory baseline increase');
  assert.deepEqual(readFileSync(join(box.root, 'bin/cell-lint-baselines/index.json')), descriptor);
  assert.throws(() => lowerCellLintBaseline(report, baseline), { code: 'CELL_LINT_ROSE' }, 'advisory debt never raises the stored ratchet');
  box.put('path-map.json', JSON.stringify({ 'src/previous.js': 'packages/sample/index.js' }));
  assert.equal(box.report().transition.active, true, 'an uncommitted path map is not accepted source evidence');
  box.git('add', '-A'); box.git('commit', '-qm', 'test: accepted first package migration');
  const after = box.report();
  assert.equal(after.transition.active, false, 'the exact committed package migration closes the transition');
  assert.deepEqual(after.transition.witness, ['src/previous.js', 'packages/sample/index.js']);
  assert.ok(cellLintGrowth(after, baseline, { enforcedOnly: true }).some(row => row.key === 'src/transition-reader.js' && !row.advisory));
  const strict = run('--check');
  assert.notEqual(strict.status, 0, 'the same real helper/test/import change is refused after the accepted source witness');
  assert.match(strict.stderr, /legacySource:src\/transition-reader\.js/u);
  assert.doesNotMatch(strict.stderr, /advisory item/u);
});

test('the pre-cell transition never excuses a real new cycle, shim, size or reachability rise [C7,CD64]', t => {
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
  for (const metric of ['cycles', 'shims', 'fileSize', 'unreachable', 'unreachableExports', 'documents', 'unknown']) {
    assert.ok(strict.some(row => row.metric === metric && !row.advisory), `${metric} remains strict`);
  }
  assert.throws(() => lowerCellLintBaseline(report, baseline), { code: 'CELL_LINT_ROSE' });
});
