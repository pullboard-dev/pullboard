/** @pullboard-test-input source-tree */
/** An app cell may declare a light front door, apps/<name>/core.js, the way a package does; a pure front door stays a package's [C7,D3]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fixture } from '../../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../../landing/tests/fixtures/plan.js';
import { cellLintReport } from '../../../../index.js';

const BIN = fileURLToPath(new URL('../../../../src/io/cells/scripts/plan.js', import.meta.url));
const DOOR = 'apps/cli/light.js';
const BODY = 'apps/cli/src/logic/cli.js';

/** Run the real cells plan CLI in the fixture; the moved check's problems come back one per line. */
function plan(root, ...args) {
  const run = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' });
  return { status: run.status, problems: run.stderr.split('\n').filter(line => line && !/ExperimentalWarning|--trace-warnings/u.test(line)) };
}

/** Set one key on a cell's plan shard, as a plan edit would. */
function declare(root, cell, key, value) {
  const index = JSON.parse(readFileSync(join(root, 'packages/codemap/data/plan/cells.json'), 'utf8'));
  const file = join(root, index.cells.find(row => row.name === cell).file);
  const shard = { ...JSON.parse(readFileSync(file, 'utf8')) };
  if (value === undefined) delete shard[key]; else shard[key] = value;
  writeFileSync(file, JSON.stringify(shard, null, 1) + '\n');
}

/** Move the fixture's app:cli behind index.js and a declared light core.js that re-exports its body. */
function movedApp(t, { body = 'export const run = () => 1;\n', door = "export { run } from './src/logic/cli.js';\n", key = 'lightFrontDoor', value = DOOR } = {}) {
  const project = fixture(t), { root, put } = project;
  put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js' }));
  put(BODY, body);
  put(DOOR, door);
  put('apps/cli/index.js', "export * from './light.js';\n");
  put('src/cli.js', "export { run } from '../apps/cli/light.js';\n");
  put('bin/tool.js', "import '../apps/cli/index.js';\n");
  assert.equal(plan(root, '--write').status, 0);
  declare(root, 'app:cli', key, value);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture moved app with a light door');
  return { ...project, moved: () => plan(root, '--moved', 'app:cli') };
}

test('an app core.js that index.js re-exports and whose closure holds only relative files passes [C7,D3]', t => {
  const { moved } = movedApp(t);
  const run = moved();
  assert.deepEqual(run.problems, []);
  assert.equal(run.status, 0);
});

test('a light app door that imports a bare package is refused with its reason [C7,D3]', t => {
  const { moved } = movedApp(t, { body: "import { thing } from 'left-pad';\nexport const run = () => thing;\n" });
  const run = moved();
  assert.equal(run.status, 1);
  assert.ok(run.problems.some(text => text.includes('left-pad') && text.includes('light front door')), run.problems.join('\n'));
});

test('an app light door must be apps/<name>/core.js and be re-exported by index.js, and an app pure door stays refused [C7,D3]', t => {
  assert.ok(movedApp(t, { value: 'apps/cli/other.js' }).moved().problems.some(text => text.includes('lightFrontDoor must be apps/cli/light.js')));
  assert.ok(movedApp(t, { key: 'pureFrontDoor' }).moved().problems.some(text => text.includes('pureFrontDoor must be apps/cli/light.js')));
});

test('a declared apps core.js is no stray in the cell lints, an undeclared one is [C7,D3]', t => {
  const { root, put } = movedApp(t);
  put('packages/codemap/data/plan/path-map/cli.json', JSON.stringify({ 'src/cli.js': BODY }));
  const strays = () => cellLintReport(root, { importsIn: sources => sources.map(() => []), commonJsIn: sources => sources.map(() => false) }).metrics.strays.findings.map(row => row.key);
  assert.ok(!strays().includes(DOOR), strays().join('\n'));
  declare(root, 'app:cli', 'lightFrontDoor', undefined);
  assert.ok(strays().includes(DOOR), 'an undeclared core.js stays a stray');
});
