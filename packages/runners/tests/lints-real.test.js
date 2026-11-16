/** @pullboard-test-input packages/codemap/src/io/cell/scripts/lints.js packages/codemap/src/io/cells/scripts/plan.js packages/codemap/data/baselines/lints/index.json */
/** @pullboard-test-input ** */
/** The cell lint tests that read the actual repository or copy real packages; split from lints.test.js for its file budget [C7,CD62,CD64]. */
import { importsIn } from '../../gate/index.js';
import { commonJsIn } from '../../gate/index.js';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { copyPackageFiles } from '../index.js';
import { packageFiles } from '../index.js';
import { cellLintReport } from '../../codemap/index.js';
import { readCellLintBaseline } from '../../codemap/index.js';
import { cellLintGrowth } from '../../codemap/index.js';
import { runFixtureGit } from '../../gate/tests/fixtures/child.js';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';

/** Create actual files and an explicit root import map; no source modules execute during reports. Reports stage first because the lint reads tracked files. */
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
  return { root, put, remove, git, report: () => { git('add', '-A'); return cellLintReport(root, { importsIn, commonJsIn }); } };
}

let realRepository = null;
/** This repository's cell lint report and committed baseline, built once: the report is the slow part, and both real-repository cases below read the same one. */
function realReport() {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  realRepository ??= { root, report: cellLintReport(root, { importsIn, commonJsIn }), baseline: readCellLintBaseline(root) };
  return realRepository;
}

test('clause 2: a report over the real repository succeeds and prints with the growth against the committed index.json, as --report does [C7,CD64]', () => {
  // lints.js --report is cellLintReport, then cellLintGrowth against the stored baseline, printed as JSON: the same calls, over the same tree, without a second multi-minute report.
  const { report, baseline } = realReport();
  const growth = cellLintGrowth(report, baseline);
  assert.ok(Array.isArray(growth), 'the real index.json binds boundaries-012 and strays-001, so the growth is computed');
  assert.doesNotThrow(() => JSON.stringify({ ...report, growth }, null, 2), 'the report prints');
});

test('the actual repository gate enforces strict cell debt and reports temporary named transition rises [C7,CD64]', () => {
  const { report, baseline } = realReport();
  const growth = cellLintGrowth(report, baseline);
  for (const row of growth.filter(row => row.advisory)) console.log(`advisory item #${row.item} until #${row.until}: ${row.metric}:${row.key}: ${row.actual} exceeds ${row.allowed}`);
  assert.deepEqual(cellLintGrowth(report, baseline, { enforcedOnly: true }), [], 'normal npm test keeps all non-transition debt strict without updating the baseline');
});

test('the actual discovered command loader reaches command run and its literal helper without excusing unused exports [C7,CD62]', t => {
  const box = fixture(t);
  const source = fileURLToPath(new URL('../../../', import.meta.url));
  copyPackageFiles(source, box.root, { files: packageFiles(source).filter(file =>
    ['src/discovery.js', 'packages/kernel/index.js', 'packages/kernel/light.js'].includes(file)
      || file.startsWith('packages/kernel/src/') || file === 'apps/cli/src/io/commands/index.js') });
  box.put('apps/demo/index.js', "import { COMMANDS } from '../cli/src/io/commands/index.js'; COMMANDS.next();\n");
  box.put('apps/cli/src/io/commands/next.js', "import { routing } from '../../../../../src/routing.js'; export function run() { return routing(); } export const unused = 1;\n");
  box.put('src/routing.js', 'export function routing() { return 1; }\n');
  box.put('src/not-a-command.js', 'export const unused = 1;\n');
  const report = box.report();
  assert.ok(!report.metrics.unreachable.findings.some(row => ['apps/cli/src/io/commands/next.js', 'src/routing.js'].includes(row.key)));
  assert.ok(!report.metrics.unreachableExports.findings.some(row => ['apps/cli/src/io/commands/next.js#run', 'src/routing.js#routing'].includes(row.key)));
  assert.ok(report.metrics.unreachableExports.findings.some(row => row.key === 'apps/cli/src/io/commands/next.js#unused'));
  assert.ok(report.metrics.unreachable.findings.some(row => row.key === 'src/not-a-command.js'));
});

test('an export used only through a literal dynamic import of a shim is reachable; a non-literal dynamic import is named unknown [C7,CD62]', t => {
  const box = fixture(t);
  box.put('packages/sample/index.js', 'export const value = 1, lazy = 2, destructured = 3, other = 4;\n');
  box.put('src/shim-sample.js', "export { lazy, destructured } from '../packages/sample/index.js';\n");
  box.put('apps/demo/index.js', "import { value } from '#sample'; console.log(value);\nconsole.log((await import('../../src/shim-sample.js')).lazy);\nconst { destructured: renamed } = await import('../../src/shim-sample.js'); console.log(renamed);\n");
  const keys = report => report.metrics.unreachableExports.findings.map(row => row.key);
  const literal = box.report();
  assert.ok(!keys(literal).includes('packages/sample/index.js#lazy'), 'member read through the shim reaches the moved export');
  assert.ok(!keys(literal).includes('packages/sample/index.js#destructured'), 'destructured read through the shim reaches the moved export');
  assert.ok(!keys(literal).includes('src/shim-sample.js#lazy'));
  assert.ok(keys(literal).includes('packages/sample/index.js#other'), 'unrelated exports stay debt');
  box.put('apps/demo/index.js', "import { value } from '#sample'; console.log(value);\nconst name = process.env.TARGET; console.log((await import(name)).lazy);\n");
  const computed = box.report();
  assert.ok(keys(computed).includes('packages/sample/index.js#lazy'), 'a non-literal specifier proves nothing');
  assert.ok(computed.unknown.some(row => row.file === 'apps/demo/index.js' && row.reason.includes('computed')), 'the non-literal import is named in the output');
});

test('discovered command reach requires the exact kernel front door and discovery body [C7,CD62]', t => {
  const box = fixture(t);
  const source = fileURLToPath(new URL('../../../', import.meta.url));
  copyPackageFiles(source, box.root, { files: packageFiles(source).filter(file =>
    file === 'packages/kernel/index.js' || file === 'packages/kernel/light.js' || file.startsWith('packages/kernel/src/')
      || file === 'apps/cli/src/io/commands/index.js') });
  box.put('apps/demo/index.js', "import { COMMANDS } from '../cli/src/io/commands/index.js'; COMMANDS.next();\n");
  box.put('apps/cli/src/io/commands/next.js', 'export function run() {}\n');
  appendFileSync(join(box.root, 'packages/kernel/light.js'), '\n// changed provider\n');
  assert.ok(box.report().metrics.unreachable.findings.some(row => row.key === 'apps/cli/src/io/commands/next.js'));
  copyPackageFiles(source, box.root, { files: ['packages/kernel/light.js'] });
  appendFileSync(join(box.root, 'packages/kernel/src/logic/discovery.js'), '\n// changed discovery\n');
  assert.ok(box.report().metrics.unreachable.findings.some(row => row.key === 'apps/cli/src/io/commands/next.js'));
});
