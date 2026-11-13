/** Paired runner rerun 5 of 5 stays inside its round trip deadline on a loaded test machine [C7]. */
import { after } from 'node:test';
import { test } from 'node:test';
import { assertLoadedPairedRerun } from '../../../../../tests/fixtures/runner/paired/loaded.js';
import { cleanupFixtureChildren } from '../../../../../tests/fixtures/child.js';
import { cleanupToolingSnapshots } from '../../../../../tests/fixtures/runner/tooling.js';

after(cleanupFixtureChildren);
after(cleanupToolingSnapshots);

test('paired rerun 5 of 5 [C7]', { timeout: 120_000, cpuLoad: true, skip: 'CONTROLLER_ONLY: deleted with #7526' }, async t => { // budget: one real paired attempt on a half-core busy stand-in.
  await assertLoadedPairedRerun(t, 5);
});
