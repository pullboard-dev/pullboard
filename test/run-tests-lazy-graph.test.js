/** Keep the test runner's lightweight landing helpers outside the gate graph [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

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
