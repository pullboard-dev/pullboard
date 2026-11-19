/** GitHub App authorization and metadata-only access against real loopback HTTP [H8, H1]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import { verify } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createGitHubClient } from '../../index.js';
import { githubAppManifest } from '../../index.js';
import { repositoryName } from '../../index.js';
import { GITHUB_API_VERSION } from '../../index.js';
import { githubFixture } from '../../../cli/tests/fixtures/relay.js';

test('relay.io-github.app-browser-grant-uses-state-and: App browser grant uses state and PKCE and is one-use [H8, H1]', async (t) => {
  const fixture = await githubFixture(t);
  const client = createGitHubClient(fixture.config);
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const authorize = new URL(client.authorizeURL(state, createHash('sha256').update(verifier).digest('base64url')));
  assert.equal(authorize.searchParams.get('state'), state);
  const response = await fetch(authorize, { redirect: 'manual' });
  const callback = new URL(response.headers.get('location'));
  assert.equal(callback.searchParams.get('state'), state);
  const result = await client.exchangeCode(callback.searchParams.get('code'), verifier);
  assert.deepEqual(await client.user(result.accessToken), { id: '7', login: 'fixture-user' });
  await assert.rejects(client.exchangeCode(callback.searchParams.get('code'), verifier), { code: 'OAUTH_EXPIRED' });
  assert.ok(fixture.calls.filter(call => call.path !== '/login/oauth/authorize').every(call => call.apiVersion === GITHUB_API_VERSION));
});

test('relay.io-github.device-grant-polls-pending-and-slow: device grant polls pending and slow-down without CLI-held secret [H8, H1]', async (t) => {
  const fixture = await githubFixture(t);
  const client = createGitHubClient(fixture.config);
  const grant = await client.startDevice();
  assert.equal((await client.pollDevice(grant.deviceCode)).pending, true);
  fixture.state.slow = true;
  assert.equal((await client.pollDevice(grant.deviceCode)).slow, true);
  await fetch(grant.verificationURL);
  const signed = await client.pollDevice(grant.deviceCode);
  assert.equal((await client.user(signed.accessToken)).id, '7');
  const polls = fixture.calls.filter(call => call.path === '/login/oauth/access_token');
  assert.ok(polls.every(call => !call.formKeys.includes('client_secret') && !call.formKeys.includes('scope')));
});

test('relay.io-github.app-metadata-checks-current-private-access: App metadata checks current private access and immutable account identity [H8, H1]', async (t) => {
  const fixture = await githubFixture(t);
  const client = createGitHubClient(fixture.config);
  const user = { id: '7', login: 'fixture-user' };
  assert.deepEqual(await client.access(user, 'fixture/repository'), { id: '100', name: 'fixture/repository', public: false, permission: 'write' });
  fixture.state.access = false;
  await assert.rejects(client.access(user, 'fixture/repository'), { code: 'NO_REPO_ACCESS' });
  fixture.state.access = true;
  fixture.state.permissionAccountID = 8;
  await assert.rejects(client.access(user, 'fixture/repository'), { code: 'NO_REPO_ACCESS' });
  fixture.state.installed = false;
  await assert.rejects(client.access(user, 'fixture/repository'), { code: 'NO_REPO_ACCESS' });
  fixture.state.public = true;
  assert.equal((await client.access(user, 'fixture/repository')).id, '100');
  assert.ok(fixture.calls.filter(call => call.path.endsWith('/permission')).every(call => call.installation && !call.user));
  assert.deepEqual(githubAppManifest(fixture.config.callbackURL).default_permissions, { metadata: 'read' });
  assert.throws(() => repositoryName('owner/../other'), { code: 'BAD_REPOSITORY' });
});

test('relay.io-github.github-credentials-never-follow-a-redirect: GitHub credentials never follow a redirect to a different origin [H8, H1]', async (t) => {
  const fixture = await githubFixture(t);
  let foreignRequests = 0;
  const foreign = createServer((req, res) => { foreignRequests += 1; res.end('{}'); });
  foreign.listen(0, '127.0.0.1');
  await once(foreign, 'listening');
  t.after(() => { foreign.closeAllConnections(); foreign.close(); });
  fixture.state.redirect = 'http://127.0.0.1:' + foreign.address().port + '/capture';
  const client = createGitHubClient(fixture.config);
  const grant = await client.startDevice();
  fixture.state.deviceAuthorized = true;
  const signed = await client.pollDevice(grant.deviceCode);
  await assert.rejects(client.user(signed.accessToken), { code: 'GITHUB_UNAVAILABLE' });
  assert.equal(foreignRequests, 0);
});


test('relay.io-github.github-roles-use-role-name-custom: GitHub roles use role_name, custom-role flags and legacy fallback [H13,H14,H8]', async (t) => {
  const fixture = await githubFixture(t);
  fixture.state.public = true;
  const client = createGitHubClient(fixture.config);
  const user = { id: '7', login: 'fixture-user' };
  for (const role of ['none', 'read', 'triage', 'write', 'maintain', 'admin']) {
    fixture.state.permission = role;
    assert.equal((await client.access(user, 'fixture/repository')).permission, role);
  }
  fixture.state.roleName = 'custom-reader';
  for (const [flags, expected] of [
    [{ pull: true }, 'read'], [{ pull: true, triage: true }, 'triage'],
    [{ pull: true, push: true }, 'write'], [{ maintain: true, push: true }, 'maintain'],
    [{ admin: true, maintain: true }, 'admin'], [{ triage: 'true', push: 'true' }, 'read'],
  ]) {
    fixture.state.permission = 'read';
    fixture.state.permissions = flags;
    assert.equal((await client.access(user, 'fixture/repository')).permission, expected);
  }
  fixture.state.roleName = 'unknown-custom';
  fixture.state.permissions = {};
  fixture.state.permission = 'none';
  assert.equal((await client.access(user, 'fixture/repository')).permission, 'none');
  fixture.state.legacyOnly = true;
  for (const role of ['none', 'read', 'write', 'admin']) {
    fixture.state.permission = role;
    assert.equal((await client.access(user, 'fixture/repository')).permission, role);
  }
  fixture.state.legacyOnly = false;
  fixture.state.roleName = 'triage';
  fixture.state.permission = 'read';
  fixture.state.permissions = { triage: true };
  fixture.state.permissionAccountID = 8;
  assert.equal((await client.access(user, 'fixture/repository')).permission, 'none');
});

test('relay.io-github.signing-adapter-app-jwt-verifies: the App JWT is signed through the keys signing adapter and verifies against the key public half [C7]', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const seen = [];
  const server = createServer((req, res) => { seen.push(req.headers.authorization); res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = 'http://127.0.0.1:' + server.address().port;
  const client = createGitHubClient({ clientId: 'fixture-app', clientSecret: 'secret', callbackURL: origin + '/callback', oauthBase: origin, apiBase: origin, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  await client.access({ id: '7', login: 'u' }, 'fixture/repository').catch(() => {});
  const jwt = seen[0].replace('Bearer ', '');
  const [head, claims, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, 'fixture-app');
  assert.ok(verify('RSA-SHA256', Buffer.from(head + '.' + claims), publicKey, Buffer.from(signature, 'base64url')));
});

test('relay.io-github.signing-adapter-bad-key-refused: a privateKey that is not a valid RSA key is refused GITHUB_CONFIG [C7]', async () => {
  const config = { clientId: 'a', clientSecret: 'b', callbackURL: 'http://127.0.0.1/callback' };
  assert.throws(() => createGitHubClient({ ...config, privateKey: 'not a key' }), { code: 'GITHUB_CONFIG' });
  const ed = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => createGitHubClient({ ...config, privateKey: ed }), { code: 'GITHUB_CONFIG' });
});
