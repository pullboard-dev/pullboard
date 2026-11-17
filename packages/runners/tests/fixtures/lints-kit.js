/** Shared setup for the cell lint tests: the private git fixture, identity reports and the metric families [C7,CD64]. The codemap and gate helpers are handed in by the test, so this file imports no other cell. */
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let helpers;
/** Receive the codemap and gate helpers the fixture needs; the test calls this once before any case runs. */
export function provideHelpers(given) { helpers = given; }

/** Create actual files and an explicit root import map; no source modules execute during reports. */
export function fixture(t) {
  const root = helpers.privateFixtureFiles('pullboard-cell-lints-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Cell fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Cell fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const runGit = (...args) => helpers.runFixtureGit(args, { cwd: root, env });
  /** The cell inventory reads tracked files only, so each fixture change is staged; a git-ignored path stays untracked on purpose. */
  const stage = file => helpers.runFixtureChild('git', ['add', '-A', '--', file], { cwd: root, env, encoding: 'utf8' });
  runGit('init', '-q', '-b', 'main');
  /** Write one private source or asset beneath this fixture. */
  function put(file, source) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source); stage(file); }
  /** Write many private files, then stage them with one Git call: hundreds of single-file stages cost one process each. */
  function putAll(files) {
    for (const [file, source] of files) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source); }
    helpers.runFixtureChild('git', ['add', '-A', '--', ...files.map(([file]) => file)], { cwd: root, env, encoding: 'utf8' });
  }
  /** Remove only the named private fixture entity. */
  function remove(file) { rmSync(join(root, file), { recursive: true, force: true }); stage(file); }
  put('package.json', JSON.stringify({ type: 'module', imports: { '#*': './packages/*/index.js', '#*.js': './packages/*.js' } }));
  put('apps/demo/index.js', "import { value } from '#sample'; console.log(value);\n");
  put('packages/sample/index.js', 'export const value = 1;\n');
  return { root, put, putAll, remove, git: runGit, stage, report: () => helpers.cellLintReport(root, { importsIn: helpers.importsIn, commonJsIn: helpers.commonJsIn }) };
}

export const BIN = fileURLToPath(new URL('../../../codemap/src/io/cell/scripts/lints.js', import.meta.url));
export const PLAN_BIN = fileURLToPath(new URL('../../../codemap/src/io/cells/scripts/plan.js', import.meta.url));
export const BASELINE_DIRECTORY = 'packages/codemap/data/baselines/lints';
export const TRANSITION_FILE = 'packages/codemap/data/plan/transition.json';
/** Build a report-shaped value for exact identity-collision controls without filesystem side effects. */
export function identityReport(pathMap, { boundaries = [], unreachableExports = [] } = {}) {
  const selected = { boundaries, unreachableExports };
  const metrics = Object.fromEntries(helpers.CELL_METRICS.map(metric => {
    const findings = selected[metric] ?? [];
    return [metric, { count: findings.reduce((sum, finding) => sum + finding.count, 0), findings }];
  }));
  return { pathMap, metrics };
}

export const FAMILIES = [
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
