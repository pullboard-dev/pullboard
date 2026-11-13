/** Direct branch board opens preserve the shared DDL while private databases still migrate [A5,A6,C7]. */
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('direct branch board opens preserve shared DDL while private databases still migrate [A5,A6,C7]', async t => {
  const { assertDirectOpenBoardIsolation } = await import('../../../../tests/fixtures/regression.js');
  assertDirectOpenBoardIsolation(t, fileURLToPath(new URL('../../../../../..', import.meta.url)));
});
