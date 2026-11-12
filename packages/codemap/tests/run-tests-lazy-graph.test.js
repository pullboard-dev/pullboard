/** @pullboard-test-input source-tree */
/** @pullboard-world-pin reads the real command modules to walk their static import graph. */
/** Test command modules defer their heavy gate execution imports [C7,#3054]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { posix } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { scanSource } from '../index.js';

const ENTRIES = ['packages/runners/src/io/run.js', 'packages/gate/src/io/test/run.js'];
const HEAVY = new Set(['packages/gate/src/io/main.js', 'packages/gate/src/io/execution.js',
  'packages/gate/src/logic/policy.js', 'packages/gate/index.js']);

/** Resolve literal static module edges without importing or executing any candidate source. */
function staticEdges(file, source) {
  return scanSource(file, source).imports.filter(edge => !edge.dynamic)
    .map(edge => edge.from.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), edge.from)) : edge.from);
}

test('clause 1: the moved src/run.js implementation and test-run have no static gate, execution or policy-load edge [C7,#3054]', () => {
  for (const file of ENTRIES) {
    const source = readFileSync(new URL('../../../' + file, import.meta.url), 'utf8');
    assert.deepEqual(staticEdges(file, source).filter(edge => HEAVY.has(edge)), [], file);
    const deferred = scanSource(file, source).imports.filter(edge => edge.dynamic).map(edge => edge.from);
    const retainsGate = file === 'packages/gate/src/io/test/run.js'
      ? ['../main.js', '../execution.js'].every(edge => deferred.includes(edge))
      : deferred.some(edge => edge.endsWith('/gate.js') || edge === '../../../gate/index.js');
    assert.ok(retainsGate, `${file} retains its real gate dependency on demand`);
  }
});

test('the static graph guard detects named and side-effect gate imports while distinguishing deferred imports [C7,#3054]', () => {
  const file = 'packages/gate/src/io/test/run.js';
  const source = `import {runGate} from '../main.js';
import '../execution.js';
async function policy() { return import('../../logic/policy.js'); }
`;
  assert.deepEqual(staticEdges(file, source).filter(edge => HEAVY.has(edge)),
    ['packages/gate/src/io/main.js', 'packages/gate/src/io/execution.js']);
});

/** Read one repository source file as UTF-8 for static graph assertions. */
function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** Collect literal module specifiers declared by static import and re-export statements. */
function staticSpecifiers(text) {
  return [...text.matchAll(/(?:\bimport\s+(?:[^;'"()]*?\s+from\s+)?|\bexport\s+(?:\*|\{[^}]*\})\s+from\s+)["']([^"']+)["']/gu)]
    .map(match => match[1]);
}

/** Walk repository-relative static imports, ignoring built-ins and package names. */
function staticGraph(entry) {
  const pending = [fileURLToPath(new URL(entry, import.meta.url))], visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of staticSpecifiers(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(file), specifier);
      pending.push(target); // An unreadable local module fails closed when visited.
    }
  }
  return visited;
}

test('runner static graph avoids landing and legacy selection routes into the gate [C7]', () => {
  const graph = staticGraph('../../gate/src/io/run-tests.js');
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const paths = new Set([...graph].map(file => relative(root, file).split(sep).join('/')));
  const gate = resolve(root, 'packages/gate/src/io/main.js');

    assert.ok(paths.has('packages/drive/src/logic/identity.js'));
  assert.ok(paths.has('packages/gate/src/io/test/selection.js'));
  assert.ok(!paths.has('packages/landing/index.js'), 'runner must not load landing through its gate-owning front door');
  assert.ok(!paths.has('src/test-selection.js'), 'runner must not use the removed selection compatibility shim');
  assert.ok(!staticGraph('../../drive/light.js').has(gate), 'clause 1: the drive light door stays gate-free');
  assert.ok(!staticGraph('../../gate/src/io/test/selection.js').has(gate), 'clause 1: the selection entry stays gate-free');
});

test('clause 2: the runner reads the worker process identity from the drive light door it already imports [C7]', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const door = new Set([...staticGraph('../../drive/light.js')].map(file => relative(root, file).split(sep).join('/')));
  assert.ok(door.has('packages/drive/src/logic/identity.js'), 'the drive light door carries the identity helpers');
  assert.match(readFileSync(new URL('../../gate/src/io/run-tests.js', import.meta.url), 'utf8'), /WorkerProcessIdentity[^;]*from '\.\.\/\.\.\/\.\.\/drive\/light\.js'/u);
});

const RUNNER_TARGETS = ['packages/store/index.js', 'packages/store/src/io/board.js', 'packages/state/src/io/machine.js', 'packages/gate/src/io/check/baseline/worker.js'];
const BARRELS = ['packages/verify/index.js', 'packages/seats/index.js'];

/**
 * Walk the literal static import graph from one entry file, recording each file's parent.
 * Dynamic imports are skipped; nothing is imported or executed.
 */
function importParents(entry) {
  const parent = new Map();
  const queue = [[entry, null]];
  while (queue.length) {
    const [file, from] = queue.shift();
    if (parent.has(file)) continue;
    parent.set(file, from);
    let source;
    try { source = readFileSync(new URL('../../../' + file, import.meta.url), 'utf8'); } catch { continue; }
    for (const to of staticEdges(file, source)) if (to.startsWith('.') || to.includes('/')) queue.push([to, file]);
  }
  return parent;
}

test('clause 1: apps/cli/src/io/run/tests.js static graph does not reach the store door, board.js, machine.js or check-baseline-worker.js through verify or seats [C7,#3056]', () => {
  const runner = importParents('packages/gate/src/io/run-tests.js');
  for (const barrel of BARRELS) assert.ok(!runner.has(barrel), `apps/cli/src/io/run/tests.js statically imports ${barrel}`);
  for (const barrel of BARRELS) {
    const graph = importParents(barrel);
    for (const target of RUNNER_TARGETS) assert.ok(!graph.has(target) || !runner.has(barrel), `${barrel} reaches ${target}`);
  }
});
