/** Real loopback GitHub protocol stand-in; all credentials and keys are generated in memory [H8, H1]. */
import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  verify,
} from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

/** Start a provider with real signed JWT verification and one-use browser/device grants. */
export async function githubFixture(t) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const state = { access: true, permission: 'write', public: false, installed: true, repositoryID: 100, repositories: ['repository', 'repository-2', 'repository-3'], qualifiedRepositories: {}, accountID: 7, permissionAccountID: 7, deviceAuthorized: false, deviceDeclined: false, deviceExpired: false, slow: false, redirect: null, beforeDevicePoll: null, beforeUser: null };
  const calls = [];
  const codes = new Map();
  // Each user credential remembers who signed in. state.signer picks the next person and state.people gives each
  // one an id and repository role; without them there is one person, fixture-user, as before.
  const userTokens = new Map();
  const installationTokens = new Set();
  const installationScopes = new Map();
  const deviceCode = randomBytes(24).toString('base64url');
  const clientSecret = randomBytes(24).toString('base64url');
  let origin;

  /** Resolve one exact repository record; non-fixture origins require explicit test provisioning. */
  function repositoryRecord(owner, name) {
    const fullName = `${owner}/${name}`;
    if (Object.hasOwn(state.qualifiedRepositories, fullName)) {
      const configured = state.qualifiedRepositories[fullName];
      assert.ok(Number.isSafeInteger(configured.id) && configured.id > 0, `${fullName} has a stable repository ID`);
      assert.ok(Number.isSafeInteger(configured.installationId) && configured.installationId > 0, `${fullName} has a stable installation ID`);
      assert.ok(configured.people && typeof configured.people === 'object' && !Array.isArray(configured.people), `${fullName} has an explicit people allowlist`);
      const duplicates = Object.entries(state.qualifiedRepositories)
        .filter(([other, value]) => other !== fullName && (value.id === configured.id || value.installationId === configured.installationId));
      assert.equal(duplicates.length, 0, `${fullName} has distinct repository and installation IDs`);
      return { owner, name, fullName, id: configured.id, installationId: configured.installationId,
        people: configured.people, public: configured.public === true };
    }
    if (owner !== 'fixture') return null;
    const index = state.repositories.indexOf(name);
    return index < 0 ? null : { owner, name, fullName, id: state.repositoryID + index, installationId: 42,
      people: null, public: state.public };
  }

  /** Installation tokens are scoped to one explicitly provisioned qualified repository. */
  function repositoryForInstallation(installationId, name) {
    const fixtureRepositories = state.repositories.map((repositoryName, index) => repositoryRecord('fixture', repositoryName));
    const qualifiedRepositories = Object.entries(state.qualifiedRepositories)
      .map(([fullName]) => { const [owner, repositoryName] = fullName.split('/'); return repositoryRecord(owner, repositoryName); });
    const matches = [...fixtureRepositories, ...qualifiedRepositories]
      .filter(repository => repository?.installationId === installationId && repository.name === name);
    assert.ok(matches.length <= 1, `installation ${installationId} and repository ${name} resolve uniquely`);
    return matches[0] ?? null;
  }

  /** Return JSON without recording provider credentials in fixture diagnostics. */
  function reply(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  }

  /** Verify App identity cryptographically, rather than accepting an arbitrary bearer string. */
  function appToken(token) {
    try {
      const [header, payload, signature] = token.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url'));
      return JSON.parse(Buffer.from(header, 'base64url')).alg === 'RS256' && claims.iss === 'fixture-app' && claims.exp > Date.now() / 1000 && claims.exp - claims.iat <= 600 && verify('RSA-SHA256', Buffer.from(header + '.' + payload), publicKey, Buffer.from(signature, 'base64url'));
    } catch { return false; }
  }

  /** Issue synthetic user credentials; only in-memory Sets ever retain their plaintext. */
  function userCredential() {
    const token = 'ghu_' + randomBytes(32).toString('base64url');
    userTokens.set(token, state.signer ?? 'fixture-user');
    return { access_token: token, token_type: 'bearer', scope: '', expires_in: 3600 };
  }

  /** Implement the actual OAuth and metadata HTTP endpoints used by the relay. */
  async function handle(req, res) {
    const url = new URL(req.url, origin);
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    const isApp = appToken(bearer);
    const isInstallation = installationTokens.has(bearer);
    const isUser = userTokens.has(bearer);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    calls.push({ method: req.method, path: url.pathname, user: isUser, app: isApp, installation: isInstallation, apiVersion: req.headers['x-github-api-version'], formKeys: [...form.keys()] });
    if (url.pathname === '/login/oauth/authorize') {
      assert.equal(url.searchParams.get('scope'), null);
      assert.equal(url.searchParams.get('client_id'), 'fixture-app');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      const code = randomBytes(24).toString('base64url');
      codes.set(code, url.searchParams.get('code_challenge'));
      const callback = new URL(url.searchParams.get('redirect_uri'));
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(303, { location: callback.href });
      return res.end();
    }
    if (url.pathname === '/login/device/code') {
      assert.deepEqual([...form.keys()], ['client_id']);
      return reply(res, 200, { device_code: deviceCode, user_code: 'TEST-ONLY', verification_uri: origin + '/login/device', expires_in: 900, interval: 1 });
    }
    if (url.pathname === '/login/device') {
      state.deviceAuthorized = true;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<p>Test account authorized.</p>');
    }
    if (url.pathname === '/login/oauth/access_token') {
      assert.equal(form.get('scope'), null);
      assert.equal(form.get('client_id'), 'fixture-app');
      if (form.has('device_code')) {
        assert.equal(form.get('client_secret'), null);
        assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
        assert.equal(form.get('device_code'), deviceCode);
        if (state.beforeDevicePoll) await state.beforeDevicePoll();
        if (state.slow) { state.slow = false; return reply(res, 200, { error: 'slow_down' }); }
        return reply(res, 200, state.deviceDeclined ? { error: 'access_denied' }
          : state.deviceExpired ? { error: 'expired_token' }
            : state.deviceAuthorized ? userCredential() : { error: 'authorization_pending' });
      }
      assert.ok(form.get('client_secret') === clientSecret, 'browser exchange uses configured App secret');
      const challenge = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      const proof = createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
      return reply(res, 200, challenge && proof === challenge ? userCredential() : { error: 'bad_verification_code' });
    }
    if (url.pathname === '/user') {
      if (state.redirect) { res.writeHead(302, { location: state.redirect }); return res.end(); }
      if (state.beforeUser) await state.beforeUser();
      const login = userTokens.get(bearer) ?? 'fixture-user';
      return reply(res, isUser ? 200 : 401, { id: state.people?.[login]?.id ?? state.accountID, login });
    }
    // The public SSH keys on an account, as GitHub lists them; state.sshKeys maps a login to its key lines [E17].
    const keysOf = /^\/users\/([^/]+)\/keys$/u.exec(url.pathname)?.[1];
    if (keysOf) return reply(res, 200, (state.sshKeys?.[decodeURIComponent(keysOf)] ?? []).map((key, index) => ({ id: index + 1, key })));
    const repositoryPath = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.*))?$/u.exec(url.pathname);
    const repository = repositoryPath ? repositoryRecord(repositoryPath[1], repositoryPath[2]) : null;
    const allowedRepository = Boolean(repository);
    const installationAccess = /^\/app\/installations\/(\d+)\/access_tokens$/u.exec(url.pathname);
    if (allowedRepository && repositoryPath[3] === 'installation') {
      return reply(res, isApp && state.installed ? 200 : 404, { id: repository.installationId });
    }
    if (installationAccess) {
      assert.ok(isApp, 'installation request has a valid RSA App JWT');
      const request = JSON.parse(raw);
      assert.equal(request.repositories.length, 1, 'installation token is scoped to one allowed fixture repository');
      assert.deepEqual(request, { repositories: request.repositories, permissions: { metadata: 'read' } });
      const scopedRepository = repositoryForInstallation(Number(installationAccess[1]), request.repositories[0]);
      if (!scopedRepository) return reply(res, 404, { message: 'not available' });
      const token = 'ghs_' + randomBytes(32).toString('base64url');
      installationTokens.add(token);
      installationScopes.set(token, scopedRepository.fullName);
      return reply(res, 201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    const installationForRepository = isInstallation && installationScopes.get(bearer) === repository?.fullName;
    if (allowedRepository && !repositoryPath[3]) {
      return reply(res, installationForRepository || repository.public ? 200 : 404,
        { id: repository.id, full_name: repository.fullName, private: !repository.public });
    }
    const asked = /^collaborators\/([^/]+)\/permission$/u.exec(repositoryPath?.[3] ?? '')?.[1];
    const people = repository?.people ?? state.people;
    const person = people && Object.hasOwn(people, asked) ? people[asked] : null;
    const legacyFixturePerson = repository?.people === null && asked === 'fixture-user';
    if (allowedRepository && asked && (person || legacyFixturePerson)) {
      if (state.beforePermission) await state.beforePermission();
      const role = person ? person.permission : state.access ? state.permission : 'none';
      const permission = { triage: 'read', maintain: 'write' }[role] || role;
      const permissions = state.permissions ?? {
        pull: ['read', 'triage', 'write', 'maintain', 'admin'].includes(role),
        triage: ['triage', 'write', 'maintain', 'admin'].includes(role),
        push: ['write', 'maintain', 'admin'].includes(role),
        maintain: ['maintain', 'admin'].includes(role), admin: role === 'admin',
      };
      const answer = { permission, user: { id: person ? person.id : state.permissionAccountID } };
      if (!state.legacyOnly) {
        answer.role_name = state.roleName ?? role;
        answer.user.permissions = permissions;
      }
      return reply(res, installationForRepository ? 200 : 403, answer);
    }
    return reply(res, 404, { message: 'not available' });
  }

  const server = createServer(handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); });
  // Callers see the issued user tokens themselves, as before; who signed in with each stays inside the stand-in.
  return { state, calls, origin, userTokens: { [Symbol.iterator]: () => userTokens.keys(), has: (token) => userTokens.has(token) }, installationTokens, config: { clientId: 'fixture-app', clientSecret, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), oauthBase: origin, apiBase: origin, callbackURL: origin + '/callback' } };
}
