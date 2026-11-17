/** @pullboard-test-input source-cell packages/stats packages/kernel */
/** The stats pure door carries the flow comparison to a browser: its closure holds no node: built-in and no shell file [C7,D3]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { compareFlowWindows } from '../browser.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SPECIFIER = /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gmu;

/** Every file the pure door reaches by static import, and the specifiers that are not repository files. */
function closure(entry) {
  const files = new Set(), outside = [], queue = [join(ROOT, entry)];
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith('.')) queue.push(join(dirname(file), specifier));
      else outside.push(`${relative(ROOT, file)} -> ${specifier}`);
    }
  }
  return { files: [...files].map(file => relative(ROOT, file)), outside };
}

test('the stats pure door reaches no node: built-in and no shell file [C7,D3]', () => {
  const { files, outside } = closure('packages/stats/browser.js');
  assert.deepEqual(outside, [], 'a browser cannot load a node: built-in or a package specifier');
  assert.deepEqual(files.filter(file => /(?:^|\/)src\/shell\//u.test(file)), [], 'a pure door reaches no shell file');
  assert.ok(files.includes('packages/stats/src/logic/flow.js'), 'the door reaches the flow comparison');
});

test('the pure door runs compareFlowWindows: no history is not fabricated, and an incomplete prefix is refused by name [C7]', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  assert.deepEqual(compareFlowWindows([], { now, windowMinutes: 60, complete: false }),
    { version: 1, available: false, reason: 'complete event history is required for comparison' });
  const empty = compareFlowWindows([], { now, windowMinutes: 60, complete: true });
  assert.equal(empty.version, 1);
});
