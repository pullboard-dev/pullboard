/** Test command modules defer their heavy gate execution imports [C7,#3054]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const graph = staticGraph('../bin/run-tests.js');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const paths = new Set([...graph].map(file => relative(root, file).split(sep).join('/')));
  const gate = resolve(root, 'packages/gate/src/shell/gate.js');

  assert.ok(paths.has('src/landing-worker-identity.js'));
  assert.ok(paths.has('packages/landing/src/core/landing-worker-identity.js'));
  assert.ok(paths.has('packages/gate/src/shell/test-selection.js'));
  assert.ok(!paths.has('packages/landing/index.js'), 'runner must not load landing through its gate-owning front door');
  assert.ok(!paths.has('src/test-selection.js'), 'runner must not use the removed selection compatibility shim');
  assert.ok(!staticGraph('../src/landing-worker-identity.js').has(gate), 'clause 1: the landing identity entry stays gate-free');
  assert.ok(!staticGraph('../packages/gate/src/shell/test-selection.js').has(gate), 'clause 1: the selection entry stays gate-free');
});

test('clause 2: the gate-free landing identity entry is placed in the cells plan as a sanctioned re-export [C7]', () => {
  const plan = JSON.parse(readFileSync(new URL('../bin/cells-plan/30-landing.json', import.meta.url), 'utf8'));
  assert.ok(plan.reexports.includes('src/landing-worker-identity.js'), 'pre-commit accepts the entry as a placed re-export, not a stray shim');
  assert.ok(plan.paths.some(move => move[0] === 'src/landing-worker-identity.js'), 'the plan places it with its moved implementation');
});
