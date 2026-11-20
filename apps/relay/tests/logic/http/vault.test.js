/** The vault route stores and returns one account's ciphertext, refuses no session, and refuses secret fields before storage [C7,H5,H15]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { apiJson } from '../../../../../packages/api/index.js';
import { apiRefusal } from '../../../../../packages/api/index.js';
import { apiStatus } from '../../../../../packages/api/index.js';
import { readApiBody } from '../../../../../packages/api/index.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { createVaultStore } from '../../../src/io/store/vault.js';
import { createVaultHandler } from '../../../src/logic/http/vault.js';

/** The refusal body the real service renders from the CLI, reduced to the code and message this test reads. */
const refusalDocument = (error) => ({ version: 1, error: { code: error.code, message: error.message } });

/** Serve the handler on loopback with a fake person session: a request with a `x-session` header is account `acct`, any other is refused. */
async function serving(run) {
  const directory = privateFixtureFiles('pullboard-vault-http-').root;
  const vaults = createVaultStore({ directory });
  const handler = createVaultHandler({
    authenticate: async (req) => {
      if (req.headers['x-session'] !== 'on') throw new Refused('AUTH_REQUIRED', 'sign in to the relay');
      return { kind: 'session', user: { id: 'acct' } };
    },
    vaults,
    http: { apiJson, apiRefusal, apiStatus, readApiBody, refusalDocument },
  });
  const server = createServer(async (req, res) => { if (!(await handler(req, res))) { res.statusCode = 404; res.end(); } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}/api/v1/vault`, vaults); } finally {
    server.close();
    vaults.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const send = (url, method, session, body) => fetch(url, { method, headers: { ...(session ? { 'x-session': 'on' } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('relay.logic-http-vault.put-and-get-round-trip-ciphertext-and-no-session-is-401: clause 1: PUT and GET on the vault route with a person session store and return the ciphertext through the vault store, and a request with no session gets 401 [C7]', async () => {
  await serving(async (url, vaults) => {
    const ciphertext = Buffer.from('sealed bytes').toString('base64url');
    const put = await send(url, 'PUT', true, { expected: 0, revision: 1, root: 'r1', ciphertext });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).revision, 1);
    assert.equal(vaults.read('acct').ciphertext.toString(), 'sealed bytes', 'the vault store holds the ciphertext');
    const got = await send(url, 'GET', true);
    assert.equal(got.status, 200);
    const stored = await got.json();
    assert.deepEqual([stored.root, stored.revision, stored.ciphertext], ['r1', 1, ciphertext]);
    assert.equal((await send(url, 'GET', false)).status, 401);
    assert.equal((await send(url, 'PUT', false, { expected: 1, revision: 2, root: 'r1', ciphertext })).status, 401);
    assert.equal(vaults.read('acct').revision, 1, 'a refused request changed nothing');
  });
});

test('relay.logic-http-vault.secret-fields-are-refused-before-storage: clause 2: a body carrying a prf, recovery or private key field is refused before storage [C7]', async () => {
  await serving(async (url, vaults) => {
    const ciphertext = Buffer.from('sealed').toString('base64url');
    for (const field of ['prf', 'recoveryKey', 'privateKey', 'PRF_output']) {
      const response = await send(url, 'PUT', true, { expected: 0, revision: 1, root: 'r1', ciphertext, [field]: 'secret' });
      assert.equal(response.status, 400, field);
      assert.match(JSON.stringify(await response.json()), /VAULT_SECRET_FIELD/u, field);
    }
    const nested = await send(url, 'PUT', true, { expected: 0, revision: 1, root: 'r1', ciphertext, extra: { privateKey: 'x' } });
    assert.equal(nested.status, 400);
    assert.equal(vaults.read('acct'), null, 'nothing was stored');
  });
});
