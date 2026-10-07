/** GitHub App user authorization and read-only repository checks for the relay (H8, H1). */
import { createPrivateKey, sign } from 'node:crypto';
import { Refused } from '../src/refused.js';

export const GITHUB_API_VERSION = '2026-03-10';

/** Require an HTTPS endpoint, allowing only loopback HTTP for a stand-in provider in tests. */
function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Refused('GITHUB_CONFIG', 'set a valid GitHub endpoint URL'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) {
    throw new Refused('GITHUB_CONFIG', 'use HTTPS for GitHub endpoints; only a loopback test provider may use HTTP');
  }
  return url;
}

/** Keep repository names as two path components, never an arbitrary provider URL. */
export function repositoryName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || (value.split('/').includes('.') || value.split('/').includes('..'))) {
    throw new Refused('BAD_REPOSITORY', 'name a GitHub repository as owner/name');
  }
  return value;
}

/** Registration asks only for metadata; user access tokens intersect the App's and user's access. */
export function githubAppManifest(callbackURL) {
  const callback = endpoint(callbackURL);
  return {
    name: 'Pullboard',
    url: 'https://pullboard.dev',
    callback_urls: [callback.href],
    hook_attributes: { url: new URL('/auth/github/events', callback).href, active: false },
    public: true,
    default_permissions: { metadata: 'read' },
    default_events: [],
    request_oauth_on_install: true,
  };
}

/** Classify provider errors without retaining or repeating its response body or credentials. */
function tokenResult(data) {
  if (['authorization_pending', 'slow_down'].includes(data.error)) {
    return { pending: true, slow: data.error === 'slow_down', interval: Number(data.interval) || undefined };
  }
  if (data.error === 'access_denied') throw new Refused('OAUTH_DENIED', 'GitHub sign-in was declined; start sign-in again if you want to continue');
  if (['expired_token', 'token_expired', 'incorrect_device_code', 'bad_verification_code'].includes(data.error)) {
    throw new Refused('OAUTH_EXPIRED', 'GitHub sign-in expired or its code is invalid; start sign-in again');
  }
  if (data.error) throw new Refused('GITHUB_AUTH', 'GitHub could not complete sign-in; check the App configuration and start again');
  if (typeof data.access_token !== 'string' || !data.access_token.startsWith('ghu_') || (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer') || (data.scope && data.scope !== '')) {
    throw new Refused('GITHUB_AUTH', 'sign in through a GitHub App with metadata read permission; OAuth App scopes are not supported');
  }
  const expiresIn = data.expires_in === undefined ? 28_800 : Number(data.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Refused('OAUTH_EXPIRED', 'the GitHub credential is expired; start sign-in again');
  return { accessToken: data.access_token, expiresIn };
}

/**
 * Use GitHub's App web/device flows, without requesting OAuth scopes or following credentials to
 * another origin. The injected loopback provider exercises the real HTTP protocol in tests.
 */
export function createGitHubClient({ clientId, clientSecret, callbackURL, oauthBase = 'https://github.com', apiBase = 'https://api.github.com', timeoutMs = 10_000, privateKey, now = Date.now }) {
  if (typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret) {
    throw new Refused('GITHUB_CONFIG', 'configure the GitHub App client id and secret before starting sign-in');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Refused('GITHUB_CONFIG', 'set a GitHub request timeout between 1 and 60000 milliseconds');
  const oauth = endpoint(oauthBase);
  const api = endpoint(apiBase);
  const callback = endpoint(callbackURL);

  const installationTokens = new Map();
  let key;
  if (privateKey) {
    try { key = createPrivateKey(privateKey); } catch { throw new Refused('GITHUB_CONFIG', 'configure a valid GitHub App RSA private key'); }
    if (key.asymmetricKeyType !== 'rsa') throw new Refused('GITHUB_CONFIG', 'configure a GitHub App RSA private key');
  }

  /** Sign a short-lived App JWT; the deployment key never enters persistent auth state. */
  function appJWT() {
    if (!key) throw new Refused('GITHUB_CONFIG', 'configure the GitHub App private key to check repository access');
    const issued = Math.floor(now() / 1000);
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iat: issued - 60, exp: issued + 540, iss: clientId })).toString('base64url');
    const unsigned = head + '.' + claims;
    return unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url');
  }

  /** Bound requests and same-origin redirects; never surface provider bodies in errors. */
  async function request(base, path, { form, token, json } = {}) {
    let url = new URL(path, base);
    const headers = { 'User-Agent': 'pullboard-relay', Accept: form ? 'application/json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': GITHUB_API_VERSION };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (json) headers['Content-Type'] = 'application/json';
    const body = form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined;
    const signal = AbortSignal.timeout(timeoutMs);
    for (let redirects = 0; redirects < 4; redirects += 1) {
      let response;
      try { response = await fetch(url, { method: form || json ? 'POST' : 'GET', headers, body, redirect: 'manual', signal }); }
      catch { throw new Refused('GITHUB_UNAVAILABLE', 'GitHub is unavailable; retry when it answers'); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        let next;
        try { next = new URL(location, url); } catch { /* Refuse malformed redirect targets below. */ }
        if (form || json || !location || !next || next.origin !== base.origin || next.username || next.password) {
          throw new Refused('GITHUB_UNAVAILABLE', 'GitHub returned an unsafe redirect; retry or check the configured endpoint');
        }
        url = next;
        continue;
      }
      if ([401, 403, 404].includes(response.status)) {
        await response.body?.cancel();
        throw new Refused('NO_REPO_ACCESS', 'GitHub cannot confirm access with this sign-in; sign in again or ask for repository access');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Refused('GITHUB_UNAVAILABLE', 'GitHub is unavailable or rate limited; retry when it answers');
      }
      let data;
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 65_536) throw new Error('response limit');
          chunks.push(chunk);
        }
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { throw new Refused('GITHUB_UNAVAILABLE', 'GitHub returned an invalid response; retry when it answers'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Refused('GITHUB_UNAVAILABLE', 'GitHub returned an invalid response; retry when it answers');
      return data;
    }
    throw new Refused('GITHUB_UNAVAILABLE', 'GitHub redirected too many times; retry or check the configured endpoint');
  }

  return {
    /** Send the browser through an App authorization with CSRF state and an S256 PKCE challenge. */
    authorizeURL(state, challenge) {
      if (typeof state !== 'string' || !state || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new Refused('OAUTH_STATE', 'start a new browser sign-in');
      const url = new URL('/login/oauth/authorize', oauth);
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback.href, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
      return url.href;
    },
    /** Exchange a one-use browser code; the service owns state validation and verifier secrecy. */
    async exchangeCode(code, verifier) {
      if (typeof code !== 'string' || !code || typeof verifier !== 'string' || !verifier) throw new Refused('OAUTH_STATE', 'start a new browser sign-in');
      return tokenResult(await request(oauth, '/login/oauth/access_token', { form: { client_id: clientId, client_secret: clientSecret, redirect_uri: callback.href, code, code_verifier: verifier } }));
    },
    /** Request a device authorization without broad OAuth scopes or a CLI-held App secret. */
    async startDevice() {
      const data = await request(oauth, '/login/device/code', { form: { client_id: clientId } });
      if (typeof data.device_code !== 'string' || !data.device_code || typeof data.user_code !== 'string' || !data.user_code || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0 || !Number.isFinite(Number(data.interval)) || Number(data.interval) <= 0) {
        throw new Refused('GITHUB_AUTH', 'GitHub returned an invalid device flow; start sign-in again');
      }
      let verification;
      try { verification = new URL(data.verification_uri); } catch { /* Refuse absent or malformed URLs below. */ }
      if (!verification || verification.origin !== oauth.origin || verification.username || verification.password) throw new Refused('GITHUB_AUTH', 'GitHub returned an unexpected verification address; start sign-in again');
      return { deviceCode: data.device_code, userCode: data.user_code, verificationURL: verification.href, expiresIn: Number(data.expires_in), interval: Number(data.interval) };
    },
    /** Poll only when the auth service permits it; GitHub's pending/slow-down results stay typed. */
    async pollDevice(deviceCode) {
      return tokenResult(await request(oauth, '/login/oauth/access_token', { form: { client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } }));
    },
    /** Confirm the current user's immutable identity before minting a relay session. */
    async user(token) {
      const data = await request(api, '/user', { token });
      if (!Number.isSafeInteger(data.id) || data.id <= 0 || typeof data.login !== 'string' || !data.login) throw new Refused('GITHUB_AUTH', 'GitHub did not confirm an account; start sign-in again');
      return { id: String(data.id), login: data.login };
    },
    /** Check current account access with App metadata, discarding every sign-in credential. */
    async access(user, name) {
      const path = '/repos/' + repositoryName(name).split('/').map(encodeURIComponent).join('/');
      let installation;
      try { installation = await request(api, path + '/installation', { token: appJWT() }); }
      catch (error) {
        if (error.code !== 'NO_REPO_ACCESS') throw error;
        const publicRepo = await request(api, path);
        if (publicRepo.private !== false || !Number.isSafeInteger(publicRepo.id) || publicRepo.id <= 0) {
          throw new Refused('NO_REPO_ACCESS', 'install the GitHub App on this repository and ask for repository access');
        }
        return { id: String(publicRepo.id), name: repositoryName(publicRepo.full_name), public: true, permission: 'none' };
      }
      if (!Number.isSafeInteger(installation.id) || installation.id <= 0) throw new Refused('NO_REPO_ACCESS', 'GitHub did not confirm an App installation; install the App on this repository');
      const cacheKey = String(installation.id) + ':' + name.toLowerCase();
      let credential = installationTokens.get(cacheKey);
      if (!credential || credential.expires <= now() + 60_000) {
        const minted = await request(api, '/app/installations/' + installation.id + '/access_tokens', {
          token: appJWT(), json: { repositories: [name.split('/')[1]], permissions: { metadata: 'read' } },
        });
        const expires = Date.parse(minted.expires_at);
        if (typeof minted.token !== 'string' || !minted.token.startsWith('ghs_') || !Number.isFinite(expires) || expires <= now()) {
          throw new Refused('GITHUB_AUTH', 'GitHub did not issue a current App token; check the App installation');
        }
        credential = { token: minted.token, expires };
        installationTokens.set(cacheKey, credential);
      }
      try {
        const repo = await request(api, path, { token: credential.token });
        if (!Number.isSafeInteger(repo.id) || repo.id <= 0 || typeof repo.private !== 'boolean') throw new Refused('NO_REPO_ACCESS', 'GitHub did not confirm repository metadata; check the App installation');
        if (!user || !/^[A-Za-z0-9-]+$/.test(user.login)) throw new Refused('NO_REPO_ACCESS', 'sign in again to confirm your GitHub account');
        let permission = 'none';
        try {
          const answer = await request(api, path + '/collaborators/' + encodeURIComponent(user.login) + '/permission', { token: credential.token });
          if (String(answer.user?.id) === String(user.id) && ['read', 'triage', 'write', 'maintain', 'admin'].includes(answer.permission)) permission = answer.permission;
        } catch (error) {
          if (repo.private || error.code !== 'NO_REPO_ACCESS') throw error;
        }
        if (repo.private && permission === 'none') throw new Refused('NO_REPO_ACCESS', 'your GitHub account cannot read this repository; ask for access or sign in again');
        return { id: String(repo.id), name: repositoryName(repo.full_name), public: !repo.private, permission };
      } catch (error) {
        if (error.code === 'NO_REPO_ACCESS') installationTokens.delete(cacheKey);
        throw error;
      }
    },
    /** A successful metadata read proves both App and user access; pin the immutable repo id. */
    async repository(token, name) {
      const [owner, repo] = repositoryName(name).split('/');
      const data = await request(api, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token });
      if (!Number.isSafeInteger(data.id) || data.id <= 0 || typeof data.full_name !== 'string') throw new Refused('NO_REPO_ACCESS', 'GitHub did not confirm this repository; ask for access or check its name');
      return { id: String(data.id), name: repositoryName(data.full_name) };
    },
  };
}
