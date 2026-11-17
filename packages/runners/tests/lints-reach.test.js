/** @pullboard-test-input packages/codemap/src/io/cell/scripts/lints.js packages/codemap/src/io/cells/scripts/plan.js packages/codemap/data/baselines/lints/index.json */
/** @pullboard-test-input ** */
/** The CD62 reach and export-debt cases of the cell lint report, split from lints.test.js [C7,CD62]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CELL_METRICS } from '../../codemap/index.js';
import { cellLintBaseline } from '../../codemap/index.js';
import { cellLintGrowth } from '../../codemap/index.js';
import { lowerCellLintBaseline } from '../../codemap/index.js';
import { runFixtureChild } from '../../gate/tests/fixtures/child.js';
import { importsIn } from '../../gate/index.js';
import { commonJsIn } from '../../gate/index.js';
import { runFixtureGit } from '../../gate/tests/fixtures/child.js';
import { cellLintReport } from '../../codemap/index.js';
import { fixture } from './fixtures/lints-kit.js';
import { provideHelpers } from './fixtures/lints-kit.js';
import { privateFixtureFiles } from '../../gate/tests/fixtures/child.js';
provideHelpers({ runFixtureGit, runFixtureChild, cellLintReport, importsIn, commonJsIn, CELL_METRICS, privateFixtureFiles });

test('runners.lints.a-named-unused-export-in-an: a named unused export in an already reached file creates distinct falling debt [C7,CD62]', t => {
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

test('runners.lints.named-and-star-re-exports-propagate: named and star re-exports propagate only the particular exports reached by an app [C7,CD62]', t => {
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

test('runners.lints.namespace-members-and-namespace-re-exports: namespace members and namespace re-exports retain per-export unknown debt for opaque uses [C7,CD62]', t => {
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

test('runners.lints.tests-and-fixture-strings-never-seed: tests and fixture strings never seed app reach; unknown loaders and missing inputs remain named debt [C7,CD62]', t => {
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

test('runners.lints.property-keys-and-member-spellings-never: property keys and member spellings never prove imported binding reads; shorthand and calls do [C7,CD62]', t => {
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

test('runners.lints.shadowed-named-and-namespace-bindings-retain: shadowed named and namespace bindings retain individual opaque export debt [C7,CD62]', t => {
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

test('runners.lints.a-package-containing-only-tests-is: a package containing only tests is distinct package debt while an app-reached front door is live [C7,CD62]', t => {
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

test('runners.lints.transitional-roots-follow-real-package-cli: transitional roots follow real package CLI/browser declarations and never arbitrary fixture HTML [C7,CD62]', t => {
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

test('runners.lints.real-apps-replace-transitional-roots-without: real apps replace transitional roots without letting test programs seed application reach [C7,CD62]', t => {
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

test('runners.lints.audited-browser-serving-roots-require-real: audited browser serving roots require real entry URLs, not every served browser asset or embedded example [C7,CD62]', t => {
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

test('runners.lints.literal-native-worker-urls-and-native: literal native worker URLs and native data reads count as reach while unused and shadowed URLs do not [C7,CD62]', t => {
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

test('runners.lints.literal-node-process-worker-arguments-reach: literal Node process worker arguments reach their file but computed and test-only input declarations stay unproven [C7,CD62]', t => {
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
