/** Test command modules defer their heavy gate execution imports [C7,#3054]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { test } from 'node:test';
import { scanSource } from '../packages/codemap/index.js';

const ENTRIES = ['packages/runners/src/shell/run.js', 'packages/gate/src/shell/test-run.js'];
const HEAVY = new Set(['packages/gate/src/shell/gate.js', 'packages/gate/src/shell/gate-execution.js',
  'packages/gate/src/core/gate-policy-load.js', 'packages/gate/index.js']);

/** Resolve literal static module edges without importing or executing any candidate source. */
function staticEdges(file, source) {
  return scanSource(file, source).imports.filter(edge => !edge.dynamic)
    .map(edge => edge.from.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), edge.from)) : edge.from);
}

test('clause 1: the moved src/run.js implementation and test-run have no static gate, execution or policy-load edge [C7,#3054]', () => {
  for (const file of ENTRIES) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.deepEqual(staticEdges(file, source).filter(edge => HEAVY.has(edge)), [], file);
    assert.ok(scanSource(file, source).imports.some(edge => edge.dynamic && edge.from.endsWith('/gate.js')
      || edge.dynamic && edge.from === '../../../gate/index.js'), `${file} retains its real gate dependency on demand`);
  }
});

test('the static graph guard detects named and side-effect gate imports while distinguishing deferred imports [C7,#3054]', () => {
  const file = 'packages/gate/src/shell/test-run.js';
  const source = `import {runGate} from './gate.js';
import './gate-execution.js';
async function policy() { return import('../core/gate-policy-load.js'); }
`;
  assert.deepEqual(staticEdges(file, source).filter(edge => HEAVY.has(edge)),
    ['packages/gate/src/shell/gate.js', 'packages/gate/src/shell/gate-execution.js']);
});

const RUNNER_TARGETS = ['src/board.js', 'src/machine.js', 'packages/gate/src/shell/check-baseline-worker.js'];
const BARRELS = ['packages/verify/index.js', 'packages/seats/index.js'];

/**
 * Walk the literal static import graph from one entry file, recording each file's parent.
 * Dynamic imports are skipped; nothing is imported or executed.
 */
function staticGraph(entry) {
  const parent = new Map();
  const queue = [[entry, null]];
  while (queue.length) {
    const [file, from] = queue.shift();
    if (parent.has(file)) continue;
    parent.set(file, from);
    let source;
    try { source = readFileSync(new URL('../' + file, import.meta.url), 'utf8'); } catch { continue; }
    for (const to of staticEdges(file, source)) if (to.startsWith('.') || to.includes('/')) queue.push([to, file]);
  }
  return parent;
}

test('clause 1: bin/run-tests.js static graph does not reach src/board.js, src/machine.js or check-baseline-worker.js through verify or seats [C7,#3056]', () => {
  const runner = staticGraph('bin/run-tests.js');
  for (const barrel of BARRELS) assert.ok(!runner.has(barrel), `bin/run-tests.js statically imports ${barrel}`);
  for (const barrel of BARRELS) {
    const graph = staticGraph(barrel);
    for (const target of RUNNER_TARGETS) assert.ok(!graph.has(target) || !runner.has(barrel), `${barrel} reaches ${target}`);
  }
});
