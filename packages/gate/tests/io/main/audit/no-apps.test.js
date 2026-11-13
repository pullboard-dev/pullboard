/** @pullboard-test-input packages/gate/src/io/main/audit/worker.js packages/gate/data/ceilings/cells-edges.json */
/** @pullboard-world-pin: clause 1 reads the audit worker source and the committed ceiling to prove no apps/ path remains. */
/** The main audit worker names no apps/ path, so its package-to-app ceiling row is gone [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const FILE = 'packages/gate/src/io/main/audit/worker.js';

test('clause 1: the audit worker names no apps/ path and the ceiling holds no row for it [C7]', () => {
  const ceilings = JSON.parse(readFileSync(new URL('../../../../data/ceilings/cells-edges.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(readFileSync(new URL(`../../../../../../${FILE}`, import.meta.url), 'utf8'), /apps\//u);
  assert.equal(ceilings.packageApps[FILE], undefined);
});
