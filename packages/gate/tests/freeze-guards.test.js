/** The guard and budget tests the freeze deleted are restored, tagged harness and never planned for deletion [C7]. */
/** @pullboard-world-pin: reads the committed test manifest and checks the restored guard files exist in the repository. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { planFreeze } from '../src/logic/test/freeze.js';

const ROOT = new URL('../../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('packages/gate/data/tests/test-manifest.json', ROOT), 'utf8'));
const GUARDS = [
  'apps/cli/journeys/imports/closure-budget.test.js',
  'apps/cli/journeys/imports/ratchet.test.js',
  'apps/cli/journeys/speed/spawns.test.js',
  'apps/cli/journeys/release/size.test.js',
  'apps/cli/journeys/doctrine/checks.test.js',
  'apps/cli/journeys/next/claims.test.js',
  'apps/cli/journeys/inbox/growth.test.js',
];

test('clause 2: the restored guard files are on disk, tagged harness, and a freeze plan never deletes them [C7]', () => {
  const plan = planFreeze(manifest.files, { owner: () => null });
  for (const file of GUARDS) {
    const row = manifest.files.find(entry => entry.file === file);
    assert.ok(existsSync(new URL(file, ROOT)), `${file} is back`);
    assert.equal(row?.kind, 'harness', `${file} is tagged harness`);
    assert.equal(row.tag, undefined, `${file} carries no freeze tag`);
    assert.ok(!plan.some(change => change.file === file), `${file} is not in the freeze plan`);
  }
});
