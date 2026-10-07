/** GitHub App authorization and metadata-only access against real loopback HTTP [H8, H1]. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createGitHubClient, githubAppManifest, repositoryName, GITHUB_API_VERSION } from '../relay/github.js';
import { githubFixture } from './relay-fixture.js';

test('App browser grant uses state and PKCE and is one-use [H8, H1]', async (t) => {
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

test('device grant polls pending and slow-down without CLI-held secret [H8, H1]', async (t) => {
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

test('App metadata checks current private access and immutable account identity [H8, H1]', async (t) => {
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

test('GitHub credentials never follow a redirect to a different origin [H8, H1]', async (t) => {
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


test('GitHub roles use role_name, custom-role flags and legacy fallback [H13,H14,H8]', async (t) => {
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
