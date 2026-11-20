/** githubKeys reads a member's SSH keys through the GitHub adapter and refuses an unavailable read [C7,#1429]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubKeys } from '../../../src/io/adapter/keys.js';
import { githubKeys as frontDoor } from '../../../index.js';

const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample';
const RSA = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABexample';

/** A fetch answering with `status` and a JSON body, recording each url and options it was asked for. */
function answering(status, body, calls = []) {
  return Object.assign(async (url, options) => {
    calls.push([String(url), options]);
    return { status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body, text: async () => JSON.stringify(body) };
  }, { calls });
}

/** Run `work` with the global fetch replaced by `fetchStub` and PULLBOARD_GITHUB_API set to `value` (or removed), restoring both afterwards. */
async function withBase(value, fetchStub, work) {
  const before = process.env.PULLBOARD_GITHUB_API, realFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;
  if (value === undefined) delete process.env.PULLBOARD_GITHUB_API; else process.env.PULLBOARD_GITHUB_API = value;
  try { return await work(); } finally { globalThis.fetch = realFetch; if (before === undefined) delete process.env.PULLBOARD_GITHUB_API; else process.env.PULLBOARD_GITHUB_API = before; }
}

test('github.io-adapter-keys.reads-well-formed-keys: clause 1: githubKeys(login) reads users/<login>/keys from the PULLBOARD_GITHUB_API base (default api.github.com) and returns only well-formed SSH keys [C7,#1429]', async () => {
  const body = [{ key: ED }, { key: RSA }, { key: 'ssh-dss AAAA' }, { key: 'ssh-ed25519 not base64!' }, { key: 7 }, {}, null];
  const defaults = answering(200, body);
  assert.deepEqual(await withBase(undefined, defaults, () => githubKeys('octo cat')), [ED, RSA]);
  assert.equal(defaults.calls[0][0], 'https://api.github.com/users/octo%20cat/keys');
  assert.equal(defaults.calls[0][1].redirect, 'manual');
  const loopback = answering(200, [{ key: ED }]);
  assert.deepEqual(await withBase('http://127.0.0.1:9/', loopback, () => githubKeys('octo')), [ED]);
  assert.equal(loopback.calls[0][0], 'http://127.0.0.1:9/users/octo/keys');
  assert.deepEqual(await withBase(undefined, answering(200, { message: 'not a list' }), () => githubKeys('octo')), []);
  assert.equal(frontDoor, githubKeys, 'the github front door exports githubKeys');
});

test('github.io-adapter-keys.refuses-unavailable: clause 2: a non-2xx answer, a redirect, a non-loopback http base or a request over 10 s is refused GITHUB_UNAVAILABLE [C7,#1429]', async () => {
  const unavailable = error => { assert.equal(error.code, 'GITHUB_UNAVAILABLE'); return true; };
  for (const status of [404, 500, 302]) await assert.rejects(withBase(undefined, answering(status, []), () => githubKeys('octo')), unavailable);
  await assert.rejects(withBase('http://example.com', answering(200, []), () => githubKeys('octo')), unavailable);
  await assert.rejects(withBase('not a url', answering(200, []), () => githubKeys('octo')), unavailable);
  let signal;
  const hung = async (url, options) => { signal = options.signal; if (signal.aborted) throw signal.reason; return new Promise(() => {}); };
  const timers = AbortSignal.timeout;
  AbortSignal.timeout = ms => { assert.equal(ms, 10_000, 'the read is aborted after 10 s'); return AbortSignal.abort(new Error('timeout')); };
  try { await assert.rejects(withBase(undefined, hung, () => githubKeys('octo')), unavailable); } finally { AbortSignal.timeout = timers; }
  assert.ok(signal.aborted, 'the abort signal reached the fetch');
});
