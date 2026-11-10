/** @pullboard-test-input source-tree */
/** @pullboard-world-pin: clause 1 reads the shipped doctrine-fast header and the bin/checks scripts to prove the declared loads. */
/** No package module reaches the CLI front door: doctrine-fast loads only its fast checks and a ratchet holds the line [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAST_CHECK_SCRIPTS } from '../../../../packages/doctrine/index.js';
import { fastCheckScript } from '../../../../packages/doctrine/index.js';
import * as gate from '../../../../packages/gate/index.js';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { runFixtureChild } from '../../../cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';
import { temporaryRepository } from '../../../cli/tests/fixtures/board/submit.js';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const FAST = 'packages/doctrine/src/io/fast.js';
const LINTS = fileURLToPath(new URL('../../../../packages/codemap/src/io/cell/scripts/lints.js', import.meta.url));

/** The forward closure of one module in a selection graph. */
function closureOf(graph, start) {
  const forward = new Map();
  for (const [dependency, importers] of graph.reverse) for (const importer of importers) {
    if (!forward.has(importer)) forward.set(importer, []);
    forward.get(importer).push(dependency);
  }
  const seen = new Set([start]);
  for (const path of seen) for (const next of forward.get(path) ?? []) seen.add(next);
  return seen;
}

test('clause 1: doctrine-fast declares and imports only scan.js and its listed @file-local checks [C7,#3808]', () => {
  const header = readFileSync(join(ROOT, FAST), 'utf8').split('\n')[0];
  const declared = /^\/\*\* @pullboard-module-loads (.+) \*\/$/u.exec(header)?.[1].split(' ');
  assert.deepEqual(declared, ['packages/gate/src/io/scan.js', ...FAST_CHECK_SCRIPTS]);
  for (const script of FAST_CHECK_SCRIPTS) assert.match(readFileSync(join(ROOT, script), 'utf8'), /@file-local\b/u, script);
  const checks = 'packages/gate/src/io';
  const marked = readdirSync(join(ROOT, checks), { recursive: true }).filter(name => name.endsWith('.js'))
    .filter(name => /@file-local\b/u.test(readFileSync(join(ROOT, checks, name), 'utf8'))).map(name => `${checks}/${name}`);
  assert.deepEqual(marked.sort(), [...FAST_CHECK_SCRIPTS].sort(), 'every @file-local check is listed, so none silently loses the fast path');
});

test('clause 1: doctrine-fast refuses an unlisted @file-local script and keeps a listed one [C7,#3808]', t => {
  const { root, write } = privateFixtureFiles('pb-fast-list-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write('bin/checks/other.js', '/** @file-local reads only its files */\n');
  write('packages/gate/src/io/catch.js', '/** @file-local reads only its files */\n');
  assert.equal(fastCheckScript(root, 'node bin/checks/other.js'), null);
  assert.equal(fastCheckScript(root, 'node packages/gate/src/io/catch.js'), 'packages/gate/src/io/catch.js');
});

test('clause 1: in the selection graph doctrine-fast reaches neither static-tree-registry.js nor apps/cli/index.js [C7,#3808]', () => {
  const graph = gate.codeMapGraph(ROOT, 'HEAD');
  const reached = closureOf(graph, FAST);
  assert.ok(reached.has('packages/gate/src/io/catch.js'), 'the declared checks stay in its closure');
  assert.equal(reached.has('packages/gate/src/io/static/registry.js'), false);
  assert.equal(reached.has('apps/cli/index.js'), false);
  assert.equal(gate.packageCliReach(graph).has(FAST), false);
});

/** A real repo whose main has one package module importing nothing from the CLI, on a candidate branch. */
function cliFixture(t) {
  const root = temporaryRepository(t, 'pb-cli-reach-');
  const put = (file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
  const git = (...args) => runFixtureGit(['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root });
  put('package.json', '{"type":"module"}\n');
  put('apps/cli/index.js', 'export const run = () => 1;\n');
  put('apps/cli/src/io/landing/audit.js', 'export const audit = () => 1;\n');
  put('packages/alpha/index.js', "export { leaf } from './src/shell/leaf.js';\n");
  put('packages/alpha/src/shell/leaf.js', 'export const leaf = () => 2;\n');
  put('packages/beta/index.js', "import { audit } from '../../apps/cli/src/io/landing/audit.js';\nexport const beta = () => audit();\n");
  git('add', '-A');
  git('commit', '-qm', 'main');
  git('checkout', '-qb', 'candidate');
  return { root, put, git, commit: () => { git('add', '-A'); git('commit', '-qm', 'candidate'); } };
}

/** Run the cells ratchet against the fixture's main, and the CLI-reach rows the cell-lints stage adds to it. */
function check(root) {
  const result = runFixtureChild(process.execPath, [LINTS, '--check', root], { cwd: ROOT, encoding: 'utf8' });
  const rows = gate.cliReachRows(root);
  return { status: result.status === 0 && rows.length === 0 ? 0 : 1, stderr: `${result.stderr}${rows.join('\n')}` };
}

test('clause 2: cell-lints --check refuses a package module that newly reaches apps/cli/index.js, naming it and its path [C7,#3808]', t => {
  const box = cliFixture(t);
  box.put('packages/alpha/src/shell/leaf.js', "import { run } from '../../../../apps/cli/index.js';\nexport const leaf = () => run();\n");
  box.commit();
  const { status, stderr } = check(box.root);
  assert.equal(status, 1);
  assert.match(stderr, /cliReach:packages\/alpha\/src\/shell\/leaf\.js: reaches apps\/cli\/index\.js through packages\/alpha\/src\/shell\/leaf\.js -> apps\/cli\/index\.js/u);
  assert.match(stderr, /cliReach:packages\/alpha\/index\.js: reaches apps\/cli\/index\.js through packages\/alpha\/index\.js -> packages\/alpha\/src\/shell\/leaf\.js -> apps\/cli\/index\.js/u);
  assert.doesNotMatch(stderr, /cliReach:packages\/beta/u, 'reach main already had is not refused');
});

test('clause 2: cell-lints --check refuses a package module that newly reaches apps/cli/src/io/landing/audit.js [C7,#3808]', t => {
  const box = cliFixture(t);
  box.put('packages/alpha/src/shell/leaf.js', "import { beta } from '../../../beta/index.js';\nexport const leaf = () => beta();\n");
  box.commit();
  const { status, stderr } = check(box.root);
  assert.equal(status, 1);
  assert.match(stderr, /cliReach:packages\/alpha\/src\/shell\/leaf\.js: reaches apps\/cli\/src\/io\/landing\/audit\.js through packages\/alpha\/src\/shell\/leaf\.js -> packages\/beta\/index\.js -> apps\/cli\/src\/io\/landing\/audit\.js/u);
});

test('clause 2: cell-lints --check passes a change that adds no package reach into the CLI [C7,#3808]', t => {
  const box = cliFixture(t);
  box.put('packages/alpha/src/shell/leaf.js', 'export const leaf = () => 3;\n');
  box.commit();
  const { status, stderr } = check(box.root);
  assert.doesNotMatch(stderr, /cliReach:/u);
  assert.equal(status, 0, stderr);
});
