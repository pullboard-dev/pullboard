/** @pullboard-test-input package.json */
/** The relay readiness probe reports its build version and highest snapshot API [C7]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { health } from '../../../src/io/deploy/health.js';

/** @pullboard-world-pin: the build version is the shipped package.json version. */
const PACKAGE = JSON.parse(readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8'));

test('clause 1: GET /health returns the build version and the highest snapshot API version [C7]', async (t) => {
  const server = createServer((req, res) => { if (!health(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, version: PACKAGE.version, snapshotApi: 2 });
  assert.equal((await fetch(`${base}/other`)).status, 404, 'only /health is answered');
  assert.equal((await fetch(`${base}/health`, { method: 'POST' })).status, 404, 'only GET is answered');
});
