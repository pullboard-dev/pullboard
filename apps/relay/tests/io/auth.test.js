/** @pullboard-test-input apps/relay/tests/fixtures/v093-data/** */
/** GitHub refusals name a rate limit as one, never as lost repository access [H5,H16]. */
/** @pullboard-world-pin: clause 1 opens a copy of the recorded v0.9.3 relay credential database, whose stored key is the subject of the proof. */
import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { createPublicKey } from 'node:crypto';
import { sign } from 'node:crypto';
import { verify } from 'node:crypto';
import { cpSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { presenceAttestation } from '../../../../packages/person/index.js';
import { createAuthHandler } from '../../index.js';
import { createRelayAuth } from '../../index.js';
import { createGitHubClient } from '../../index.js';
import { githubFixture } from '../../../cli/tests/fixtures/relay.js';
import { grantChallenge } from '../../../cli/tests/fixtures/person/passkey.js';
import { softwarePasskey } from '../../../cli/tests/fixtures/person/passkey.js';

test('relay.io-auth.a-github-rate-limit-is-named: a GitHub rate limit is named as one [H5,H16]', async (t) => {
  const fixture = await githubFixture(t);
  const reset = Math.floor(Date.now() / 1000) + 600;
  const limited = createServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
    res.end('{"message":"API rate limit exceeded"}');
  });
  limited.listen(0, '127.0.0.1');
  await once(limited, 'listening');
  t.after(() => { limited.closeAllConnections(); limited.close(); });
  const lines = [];
  const user = { id: '7', login: 'fixture-user' };
  const rateLimited = createGitHubClient({ ...fixture.config, apiBase: 'http://127.0.0.1:' + limited.address().port, log: line => lines.push(line) });
  const resetAt = new Date(reset * 1000).toISOString();
  await assert.rejects(rateLimited.access(user, 'fixture/repository'), (error) => {
    assert.equal(error.code, 'GITHUB_RATE_LIMITED');
    assert.match(error.message, new RegExp(resetAt.replace(/[.]/g, '\\.')));
    return true;
  });
  const relay = createServer(createAuthHandler({ auth: { boardsFor: () => rateLimited.access(user, 'fixture/repository') }, publicOrigin: 'http://127.0.0.1' }));
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  t.after(() => { relay.closeAllConnections(); relay.close(); });
  const answer = await fetch('http://127.0.0.1:' + relay.address().port + '/auth/boards');
  assert.equal(answer.status, 429);
  assert.equal((await answer.json()).error.code, 'GITHUB_RATE_LIMITED');
  assert.ok(lines.some(line => line.includes('403') && line.includes('x-ratelimit-remaining=0') && line.includes('x-ratelimit-reset=' + reset)), lines.join('\n'));

  fixture.state.installed = false;
  const real = createGitHubClient({ ...fixture.config, log: line => lines.push(line) });
  await assert.rejects(real.access(user, 'fixture/repository'), { code: 'NO_REPO_ACCESS' });
  assert.ok(lines.some(line => line.includes('404')), lines.join('\n'));
});

/** The relay's stored passkey stamp key, read straight from its database file. */
function storedAuthority(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT private_key,public_key FROM relay_person_authority WHERE slot=1').get(); } finally { db.close(); }
}

test('relay.io-auth.signing-adapter-stored-key-signs: clause 1: personAuthorityKeys makes its pair with the keys front door adapter, and a relay database from the v0.9.3 fixture keeps and signs with its stored key [C7,#1428]', async (t) => {
  const directory = privateFixtureFiles('pullboard-relay-signing-').root;
  cpSync(join(import.meta.dirname, '..', 'fixtures', 'v093-data', 'data', 'auth.sqlite'), join(directory, 'auth.sqlite'));
  const provider = await githubFixture(t);
  const options = { database: join(directory, 'auth.sqlite'), github: createGitHubClient(provider.config) };
  const first = createRelayAuth(options);
  t.after(() => { first.close(); rmSync(directory, { recursive: true, force: true }); });
  const published = first.personAuthority().publicKey;
  const stored = storedAuthority(options.database);
  assert.equal(stored.public_key, published, 'the first use stores the pair it publishes');
  assert.match(stored.private_key, /^[A-Za-z0-9_-]+$/u, 'the stored private half stays base64url DER');
  const second = createRelayAuth(options);
  t.after(() => second.close());
  assert.equal(second.personAuthority().publicKey, published, 'a later relay on the same database keeps its stored key');
  const signature = sign(null, Buffer.from('stamp'), createPrivateKey({ key: Buffer.from(stored.private_key, 'base64url'), format: 'der', type: 'pkcs8' }));
  assert.equal(verify(null, Buffer.from('stamp'), createPublicKey({ key: Buffer.from(published, 'base64url'), format: 'der', type: 'spki' }), signature), true, 'the stored private key signs for the published public key');
});

test('relay.io-auth.signing-adapter-stamp-verifies: clause 2: on the real personPresence path the stamp signature verifies with node:crypto against the stored public_key [C7,#1428]', async (t) => {
  const provider = await githubFixture(t);
  const directory = privateFixtureFiles('pullboard-relay-stamp-').root;
  const database = join(directory, 'auth.sqlite');
  const auth = createRelayAuth({ database, github: createGitHubClient(provider.config) });
  t.after(() => { auth.close(); rmSync(directory, { recursive: true, force: true }); });
  const flow = auth.beginWeb();
  const authorization = await fetch(flow.authorizationURL, { redirect: 'manual' });
  const callback = new URL(authorization.headers.get('location'));
  const phone = await auth.finishWeb(callback.searchParams.get('state'), callback.searchParams.get('code'), flow.binding);
  const principal = await auth.authenticate(phone.token);
  const expected = { origin: 'https://relay.example', rpId: 'relay.example' };
  const passkey = softwarePasskey(expected.origin);
  const challenge = auth.passkeyChallenge(principal);
  auth.registerPasskey(principal, { challenge: challenge.challenge, ...passkey.create(challenge.challenge) }, expected);
  const board = 'a'.repeat(32);
  const request = 'stamp-request';
  const digest = 'b'.repeat(64);
  const { grant } = auth.issuePersonGrant(principal, board, { request, digest });
  const { stamp } = auth.personPresence(principal, board, { grant, ...passkey.get(grantChallenge(grant)) }, expected);
  const { signature, ...unsigned } = stamp;
  const publicKey = storedAuthority(database).public_key;
  assert.equal(publicKey, auth.personAuthority().publicKey);
  assert.equal(verify(null, presenceAttestation(unsigned), createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' }), Buffer.from(signature, 'base64url')), true, 'the stamp signature verifies against the stored public key');
});
