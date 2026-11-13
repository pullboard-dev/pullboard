/** The main-red routing cases that run beside take.test.js so no file passes the per-file time budget [C7,N2,H16]. */
import { assertFreeMainRedRouting } from '../../tests/fixtures/main/routing.js';
import { assertMainRedCLI } from '../../tests/fixtures/main/routing.js';
import { assertNewestMainRedRouting } from '../../tests/fixtures/main/routing.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';
import { test } from 'node:test';

// Main-red build routing is separate from review-priority selection.
test('a main red offers a free idle seat before interrupting a build [C7,N2]', async t => {
  assertFreeMainRedRouting(t);
});

test('a main red asks the newest build only when no seat is free and preserves native claim guards [C7,N2]', async t => {
  assertNewestMainRedRouting(t);
});

test('default next offers actual main red to another free seat and only that seat claims it [C7,N2,H16]', async t => {
  await assertMainRedCLI(t, { fixture, cli });
});
