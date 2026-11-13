/** @pullboard-test-input packages/runners/src/io/dispatch.js packages/runners/src/io/pull/delegate.js packages/gate/data/ceilings/cells-edges.json */
/** @pullboard-world-pin: clause 1 reads the dispatch and pull delegate sources and the committed ceiling to prove no apps/ path remains. */
/** Runner dispatch and the pull delegate name no apps/ path, so their package-to-app ceiling rows are gone [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const FILES = ['packages/runners/src/io/dispatch.js', 'packages/runners/src/io/pull/delegate.js'];

test('clause 1: dispatch.js and pull/delegate.js name no apps/ path and the ceiling holds no row for them [C7]', () => {
  const ceilings = JSON.parse(readFileSync(new URL('../../../gate/data/ceilings/cells-edges.json', import.meta.url), 'utf8'));
  for (const file of FILES) {
    assert.doesNotMatch(readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8'), /apps\//u, file);
    assert.equal(ceilings.packageApps[file], undefined, file);
  }
});
