/** @pullboard-test-input source-cell apps/cli */
/** serve.pullRoute mounts the board pull adapter at /pull/ in the serve request handler, and is off by default [C7,#8765]. */
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { createPrivateKey } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PULL_STORE_FILE } from '../../../../packages/transport/index.js';
import { issueRunnerKey } from '../../../../packages/transport/index.js';
import { pullStatement } from '../../../../packages/transport/index.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { pullRouteHandler } from '../../src/io/commands/serve.js';

/** A scratch board folder and the machine home that holds no settings, both removed after the test. */
function folders(t) {
  const root = privateFixtureFiles('pullboard-serve-pull-').root;
  const original = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'machine');
  t.after(() => { rmSync(root, { recursive: true, force: true }); if (original === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = original; });
  return join(root, 'board');
}

/** Serve a request handler on a free loopback port for the test and return its origin. */
async function listening(t, handler) {
  const server = createServer(handler);
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  t.after(() => new Promise(done => { server.close(() => done()); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const memory = () => new DatabaseSync(':memory:');

test('cli.io-serve-pull-route.serve-pullroute-is-off-by-default-and: clause 1: serve.pullRoute is off by default and serve builds no pull handler for /pull/ [C7,#8765]', t => {
  const folder = folders(t);
  assert.equal(pullRouteHandler({ folder, openDb: memory }), null, 'the setting unset mounts nothing');
  assert.equal(pullRouteHandler({ folder, openDb: memory, enabled: false }), null, 'the setting off mounts nothing');
  assert.equal(existsSync(join(folder, PULL_STORE_FILE)), false, 'with the route off no pull store is made');
});

test('cli.io-serve-pull-route.with-serve-pullroute-on-post-pull-register: clause 2: with serve.pullRoute on, POST /pull/register is answered by the board pull adapter over the board folder store [C7,#8765]', async t => {
  const folder = folders(t);
  const key = issueRunnerKey(folder, 'r1');
  const handler = pullRouteHandler({ folder, openDb: memory, enabled: true });
  assert.equal(typeof handler, 'function');
  const origin = await listening(t, handler);
  const at = Date.now();
  const privateKey = createPrivateKey({ key: Buffer.from(key.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  const signature = sign(null, Buffer.from(pullStatement('register', 'r1', at)), privateKey).toString('base64url');
  const registered = await fetch(`${origin}/pull/register`, { method: 'POST', body: JSON.stringify({ runner: 'r1', publicKey: key.publicKey, at, signature }) });
  assert.equal(registered.status, 200, await registered.clone().text());
  assert.ok(existsSync(join(folder, PULL_STORE_FILE)), 'the registration is kept in the board folder pull store');
  const unsigned = await fetch(`${origin}/pull/register`, { method: 'POST', body: JSON.stringify({ runner: 'r1', publicKey: key.publicKey, at, signature: 'x' }) });
  assert.equal(unsigned.status, 403, 'the adapter refuses a registration its key did not sign');
  assert.equal((await unsigned.json()).code, 'PULL_SIGNATURE');
});
