/** Real loopback GitHub protocol stand-in; all credentials and keys are generated in memory [H8, H1]. */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

/** Start a provider with real signed JWT verification and one-use browser/device grants. */
export async function githubFixture(t) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const state = { access: true, permission: 'write', public: false, installed: true, repositoryID: 100, accountID: 7, permissionAccountID: 7, deviceAuthorized: false, slow: false, redirect: null };
  const calls = [];
  const codes = new Map();
  const userTokens = new Set();
  const installationTokens = new Set();
  const deviceCode = randomBytes(24).toString('base64url');
  const clientSecret = randomBytes(24).toString('base64url');
  let origin;

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
    userTokens.add(token);
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
        if (state.slow) { state.slow = false; return reply(res, 200, { error: 'slow_down' }); }
        return reply(res, 200, state.deviceAuthorized ? userCredential() : { error: 'authorization_pending' });
      }
      assert.ok(form.get('client_secret') === clientSecret, 'browser exchange uses configured App secret');
      const challenge = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      const proof = createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
      return reply(res, 200, challenge && proof === challenge ? userCredential() : { error: 'bad_verification_code' });
    }
    if (url.pathname === '/user') {
      if (state.redirect) { res.writeHead(302, { location: state.redirect }); return res.end(); }
      return reply(res, isUser ? 200 : 401, { id: state.accountID, login: 'fixture-user' });
    }
    if (url.pathname === '/repos/fixture/repository/installation') return reply(res, isApp && state.installed ? 200 : 404, { id: 42 });
    if (url.pathname === '/app/installations/42/access_tokens') {
      assert.ok(isApp, 'installation request has a valid RSA App JWT');
      assert.deepEqual(JSON.parse(raw), { repositories: ['repository'], permissions: { metadata: 'read' } });
      const token = 'ghs_' + randomBytes(32).toString('base64url');
      installationTokens.add(token);
      return reply(res, 201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (url.pathname === '/repos/fixture/repository') return reply(res, isInstallation || state.public ? 200 : 404, { id: state.repositoryID, full_name: 'fixture/repository', private: !state.public });
    if (url.pathname === '/repos/fixture/repository/collaborators/fixture-user/permission') {
      if (state.beforePermission) await state.beforePermission();
      const role = state.access ? state.permission : 'none';
      const permission = { triage: 'read', maintain: 'write' }[role] || role;
      const permissions = state.permissions ?? {
        pull: ['read', 'triage', 'write', 'maintain', 'admin'].includes(role),
        triage: ['triage', 'write', 'maintain', 'admin'].includes(role),
        push: ['write', 'maintain', 'admin'].includes(role),
        maintain: ['maintain', 'admin'].includes(role), admin: role === 'admin',
      };
      const answer = { permission, user: { id: state.permissionAccountID } };
      if (!state.legacyOnly) {
        answer.role_name = state.roleName ?? role;
        answer.user.permissions = permissions;
      }
      return reply(res, isInstallation ? 200 : 403, answer);
    }
    return reply(res, 404, { message: 'not available' });
  }

  const server = createServer(handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { state, calls, origin, userTokens, installationTokens, config: { clientId: 'fixture-app', clientSecret, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), oauthBase: origin, apiBase: origin, callbackURL: origin + '/callback' } };
}
