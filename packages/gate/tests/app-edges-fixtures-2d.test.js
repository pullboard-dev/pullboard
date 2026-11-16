/** @pullboard-test-input source-cell gate */
/** The gate lease fixture no longer imports or re-exports the CLI app's lease, native or view modules; this slice of #6462 is #9604 [C7,CD12]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const FILE = join(import.meta.dirname, 'fixtures/resources/lease.js');
const APP_MODULE = /(?:import|export)\b[^;]*?from\s*['"][^'"]*apps\/cli\/(?:tests\/fixtures\/resources\/lease|tests\/fixtures\/native|src\/io\/commands\/view)\.js['"]/;

test('clause 1: lease.js has no import of, or export from, the CLI lease helper, native fixture or view command [C7]', () => {
  const source = readFileSync(FILE, 'utf8');
  assert.equal(APP_MODULE.test(source), false, 'lease.js still imports or re-exports an apps/cli module');
});

test('clause 2: lease.js still exports openPrivateScopedView [C7]', async () => {
  const lease = await import(FILE);
  assert.equal(typeof lease.openPrivateScopedView, 'function');
});
