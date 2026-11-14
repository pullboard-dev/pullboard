/** @pullboard-test-input source-tree */
/** A moved cell's shims must re-export through its front door; the bounded exceptions are exact and named [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { computePlan } from '../../../../../packages/codemap/index.js';
import { writePlan } from '../../../../../packages/codemap/index.js';
import { checkMoved } from '../../../../../packages/codemap/src/io/cells/scripts/plan.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { fixture } from '../../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../../packages/landing/tests/fixtures/plan.js';

const BIN = fileURLToPath(new URL('../../../../../packages/codemap/src/io/cells/scripts/plan.js', import.meta.url));

/** Stage every fixture file: the cell inventory reads only what Git tracks, staged changes included, so an unstaged put is invisible to a lint [C7,D3]. */
function stage(root) { git(root, 'add', '-A'); }

test('a moved shim that bypasses its unreachable front door fails by both paths [C7,D3,CD64]', t => {
  const { root, put } = fixture(t);
  put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js' }));
  const plan = computePlan(root);
  writePlan(root, plan);
  put('packages/kernel/src/logic/refused.js', 'export class Refused extends Error {}\n');
  put('packages/kernel/index.js', "export { Refused } from './src/logic/refused.js';\n");
  put('src/refused.js', "export { Refused } from '../packages/kernel/light.js';\n");
  stage(root);
  const problems = checkMoved(root, plan, 'kernel');
  assert.ok(problems.some(problem => problem.includes('src/refused.js bypasses front door packages/kernel/index.js')), problems.join('\n'));
  assert.ok(problems.some(problem => problem.includes('unreachable front door packages/kernel/index.js')), problems.join('\n'));
  const run = runFixtureChild(process.execPath, [BIN, '--moved', 'kernel'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /src\/refused\.js.*packages\/kernel\/index\.js/u);
});

test('only exact named own-body worker shims pass the bounded process-entry exception [C7,D3,CD64]', t => {
  for (const mode of ['worker', 'non-worker', 'wrong-leaf', 'star', 'opaque', 'oversize']) {
    const { root, put } = fixture(t);
    put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js', files: ['package.json', 'src/**', 'packages/**'] }));
    const plan = computePlan(root);
    writePlan(root, plan);
    put('packages/kernel/src/logic/refused.js', 'export class Refused extends Error {}\n');
    put('packages/kernel/src/logic/other.js', 'export class Refused extends Error {}\n');
    put('packages/kernel/index.js', "export { Refused } from './src/logic/refused.js';\n");
    put('src/board.js', "import { Refused } from '../packages/kernel/index.js';\nexport const board = () => Refused;\n");
    const leaf = mode === 'wrong-leaf' ? 'other' : 'refused';
    const bindings = mode === 'star' ? '*' : '{ Refused }';
    put('src/refused.js', `export ${bindings} from '../packages/kernel/src/logic/${leaf}.js';\n`);
    let worker = mode === 'non-worker' ? 'export const worker = true;\n' : "import { Refused } from '../../../../../src/refused.js';\nexport const worker = Refused;\n";
    if (mode === 'opaque') worker += 'new URL(process.env.UNKNOWN_WORKER_PATH, import.meta.url);\n';
    if (mode === 'oversize') worker += `export const padding = '${'x'.repeat(1_048_576)}';\n`;
    put('apps/runner/src/io/scripts/worker.js', worker);
    // Once any app file exists the production roots are apps/*/index.js, so the runner app reaches the worker and the board.
    put('apps/runner/index.js', "import './src/io/scripts/worker.js';\nimport '../../src/board.js';\n");
    stage(root);
    const problems = checkMoved(root, plan, 'kernel');
    if (mode === 'worker') assert.deepEqual(problems, [], 'a closed actual worker may retain its exact named own-body shim');
    else assert.ok(problems.some(problem => problem.includes('src/refused.js bypasses front door')), `${mode}: ${problems.join('\n')}`);
  }
});

test('only exact named own-body move shims pass the bounded move-registry exception [C7,D3,CD64]', t => {
  for (const mode of ['move', 'outside', 'wrong-leaf', 'star', 'opaque', 'oversize']) {
    const { root, put } = fixture(t);
    put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js', files: ['package.json', 'src/**', 'packages/**'] }));
    const plan = computePlan(root);
    writePlan(root, plan);
    put('packages/kernel/src/logic/refused.js', 'export class Refused extends Error {}\n');
    put('packages/kernel/src/logic/other.js', 'export class Refused extends Error {}\n');
    put('packages/kernel/index.js', "export { Refused } from './src/logic/refused.js';\n");
    put('src/board.js', "import { Refused } from '../packages/kernel/index.js';\nexport const board = () => Refused;\n");
    const leaf = mode === 'wrong-leaf' ? 'other' : 'refused';
    const bindings = mode === 'star' ? '*' : '{ Refused }';
    put('src/refused.js', `export ${bindings} from '../packages/kernel/src/logic/${leaf}.js';\n`);
    put('apps/runner/src/io/scripts/worker.js', 'export const worker = true;\n');
    put('apps/runner/index.js', "import './src/io/scripts/worker.js';\nimport '../../src/board.js';\n");
    let move = mode === 'outside' ? 'export const move = true;\n'
      : "import { Refused } from '../refused.js';\nexport const move = Refused;\n";
    if (mode === 'opaque') move += 'await import(process.env.UNKNOWN_MOVE_PATH);\n';
    if (mode === 'oversize') move += `export const padding = '${'x'.repeat(1_048_576)}';\n`;
    put('src/moves/fixtureMove.js', move);
    stage(root);
    const problems = checkMoved(root, plan, 'kernel');
    if (mode === 'move') assert.deepEqual(problems, [], 'an actual bounded move closure retains its exact named own-body shim');
    else assert.ok(problems.some(problem => problem.includes('src/refused.js bypasses front door')), `${mode}: ${problems.join('\n')}`);
  }
});

test('a correct shim does not make an otherwise unreachable moved package reachable [C7,D3,CD64]', t => {
  const { root, put } = fixture(t);
  put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js' }));
  const plan = computePlan(root);
  writePlan(root, plan);
  put('packages/kernel/src/logic/refused.js', 'export class Refused extends Error {}\n');
  put('packages/kernel/index.js', "export { Refused } from './src/logic/refused.js';\n");
  put('src/refused.js', "export { Refused } from '../packages/kernel/index.js';\n");
  put('src/board.js', "import { claims } from './claims.js';\nexport const board = () => claims;\n");
  stage(root);
  assert.ok(checkMoved(root, plan, 'kernel').some(problem => problem.includes('unreachable front door packages/kernel/index.js')));
});


test('moved shim exceptions require a live edge or trusted historical import [C7,D3,CD64]', t => {
  for (const mode of ['live', 'expired', 'history', 'uncommitted-history', 'unreferenced', 'wrong-leaf']) {
    const { root, put } = fixture(t);
    put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js' }));
    if (mode === 'history') {
      put('packages/state/data/history/152.json', JSON.stringify({ version: 1, engine: 152, declarations: { 'fixtureMove.js': "import '../refused.js';\n" } }));
      git(root, 'add', 'packages/state/data/history/152.json');
      git(root, 'commit', '-q', '-m', 'seal history');
    }
    const plan = computePlan(root);
    writePlan(root, plan);
    put('packages/kernel/src/logic/refused.js', 'export class Refused extends Error {}\n');
    put('packages/kernel/src/logic/other.js', 'export class Refused extends Error {}\n');
    put('packages/kernel/index.js', "export { Refused } from './src/logic/refused.js';\n");
    put('src/board.js', "import { Refused } from '../packages/kernel/index.js';\nexport const board = () => Refused;\n");
    put('src/refused.js', `export { Refused } from '../packages/kernel/src/logic/${mode === 'wrong-leaf' ? 'other' : 'refused'}.js';\n`);
    if (['live', 'expired', 'wrong-leaf'].includes(mode)) put('packages/codemap/data/plan/temporary-edges.json', JSON.stringify({ version: 1, edges: [{ importer: 'src/refused.js', target: 'packages/kernel/src/logic/refused.js', contractItem: 42, expires: mode === 'expired' ? '2000-01-01' : '2999-01-01' }] }));
    if (mode === 'uncommitted-history') put('packages/state/data/history/152.json', JSON.stringify({ version: 1, engine: 152, declarations: { 'fixtureMove.js': "import '../refused.js';\n" } }));
    stage(root);
    const notes = [], problems = checkMoved(root, plan, 'kernel', { notes });
    if (mode === 'live' || mode === 'history') {
      assert.deepEqual(problems, [], `${mode}: ${problems.join('\n')}`);
      assert.match(notes.join('\n'), mode === 'live' ? /live temporary edge #42/u : /sealed move history/u);
    } else assert.ok(problems.some(problem => problem.includes('src/refused.js bypasses front door')), `${mode}: ${problems.join('\n')}`);
  }
});
