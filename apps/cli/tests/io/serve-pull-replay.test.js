/** @pullboard-test-input source-cell apps/cli */
/** A replayed pull take against the served pull route is refused PULL_REPLAY [C7,#8766]. */
import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { sign } from 'node:crypto';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { issueRunnerKey } from '../../../../packages/transport/index.js';
import { pullStatement } from '../../../../packages/transport/index.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { pullRouteHandler } from '../../src/io/commands/serve.js';

/** A scratch board folder and a machine home that holds no settings, both removed after the test. */
function folders(t) {
  const root = privateFixtureFiles('pullboard-serve-replay-').root;
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

test('cli.io-serve-pull-replay.a-replayed-signed-take-against-the-served: clause 1: a replayed signed take against the served pull route is refused PULL_REPLAY and a fresh nonce is accepted [C7,#8766]', async t => {
  const folder = folders(t);
  const key = issueRunnerKey(folder, 'r1');
  const origin = await listening(t, pullRouteHandler({ folder, openDb: () => new DatabaseSync(':memory:'), enabled: true }));
  const privateKey = createPrivateKey({ key: Buffer.from(key.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  const signText = text => sign(null, Buffer.from(text), privateKey).toString('base64url');
  const at = Date.now();
  const registered = await fetch(`${origin}/pull/register`, { method: 'POST', body: JSON.stringify({ runner: 'r1', publicKey: key.publicKey, at, signature: signText(pullStatement('register', 'r1', at)) }) });
  assert.equal(registered.status, 200, await registered.clone().text());
  const take = nonce => fetch(`${origin}/pull/take`, { method: 'POST', body: JSON.stringify({ runner: 'r1', at, nonce, signature: signText(pullStatement('take', 'r1', at, nonce)) }) });
  const first = await take('replay-nonce-0000001');
  assert.equal(first.status, 204, 'the first take with this nonce is accepted and finds no job offered');
  const replay = await take('replay-nonce-0000001');
  assert.equal(replay.status, 403, 'the same signed take sent again is refused');
  assert.equal((await replay.json()).code, 'PULL_REPLAY');
  const fresh = await take('replay-nonce-0000002');
  assert.equal(fresh.status, 204, 'a fresh nonce is accepted after the replay');
});
