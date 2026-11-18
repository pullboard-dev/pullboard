/** @pullboard-test-input source-cell packages/spec */
/** Row apply loads the state light door, never the state machine module [C7,#6480,#10744]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const entry = resolve(root, 'packages/spec/src/io/row/apply.js');
const STATIC_IMPORT = /(?:^|[\n;])\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]/gu;

/** Resolve a relative specifier to a file, trying the path itself then its index.js. */
function resolveSpecifier(from, specifier) {
  const target = resolve(dirname(from), specifier);
  if (existsSync(target) && statSync(target).isFile()) return target;
  const index = resolve(target, 'index.js');
  return existsSync(index) ? index : null;
}

/** Every file reachable from the entry through static imports and re-exports. */
function staticClosure(start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop();
    for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
      const next = resolveSpecifier(file, match[1]);
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

test('spec.io-row-apply.never-reaches-state-machine: clause 1: the static imports of apply.js reach neither the state barrel nor the state machine module [C7,#6480]', () => {
  const reached = [...staticClosure(entry)].map((file) => relative(root, file));
  assert.ok(reached.includes('packages/state/light.js'), 'apply.js still reads ENGINE_VERSION from the state light door');
  assert.equal(reached.includes('packages/state/index.js'), false, 'the state barrel is not reached');
  assert.equal(reached.includes('packages/state/src/io/machine.js'), false, 'the state machine module is not reached');
});
