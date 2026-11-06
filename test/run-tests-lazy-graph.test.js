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
