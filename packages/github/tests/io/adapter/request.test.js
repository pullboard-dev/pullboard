/** The GitHub request adapter's real form and fake form answer one contract suite [C7,#1429]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeGithubAdapter } from '../../../index.js';
import { createGithubAdapter } from '../../../index.js';

const REPOSITORY = { status: 200, body: { full_name: 'owner/name', private: false } };

/** Both forms, each seeded to answer GET /repos/owner/name with REPOSITORY; the real form also records each URL it fetched. */
function forms() {
  const urls = [];
  const stubbedFetch = async (url) => { urls.push(url); return { status: REPOSITORY.status, json: async () => REPOSITORY.body }; };
  return {
    urls,
    all: [
      ['real', createGithubAdapter(stubbedFetch)],
      ['fake', createFakeGithubAdapter({ '/repos/owner/name': REPOSITORY })],
    ],
  };
}

test('github.request.get-one-repository-path: clause 1: the real form over a stubbed fetch and the fake form both return { status, body } for a GET of one repository path [C7,#1429]', async () => {
  const { urls, all } = forms();
  for (const [form, adapter] of all) {
    assert.deepEqual(await adapter.request('/repos/owner/name'), REPOSITORY, `${form} form answers { status, body }`);
  }
  assert.deepEqual(urls, ['https://api.github.com/repos/owner/name'], 'the real form wraps the api.github.com base around the path');
});

test('github.request.refuse-a-path-without-a-slash: clause 2: both forms refuse a path that does not start with a slash with the same named refusal [C7,#1429]', async () => {
  const codes = [];
  for (const [form, adapter] of forms().all) {
    await assert.rejects(adapter.request('repos/owner/name'), (error) => { codes.push(error.code); return error.name === 'Refused'; }, `${form} form refuses`);
  }
  assert.deepEqual(codes, ['GITHUB_PATH_RELATIVE', 'GITHUB_PATH_RELATIVE']);
});

test('github.io-adapter-request.base-requests-the-given-base: clause 1: createGithubAdapter(fetch, { base }) requests that base instead of https://api.github.com, and a trailing slash adds no double slash [C7,#1429]', async () => {
  const urls = [];
  const stubbedFetch = async (url) => { urls.push(url); return { status: 200, json: async () => ({}) }; };
  await createGithubAdapter(stubbedFetch, { base: 'https://github.example.test/api/v3/' }).request('/repos/owner/name');
  await createGithubAdapter(stubbedFetch, { base: 'http://127.0.0.1:8123' }).request('/user');
  assert.deepEqual(urls, ['https://github.example.test/api/v3/repos/owner/name', 'http://127.0.0.1:8123/user']);
});

test('github.io-adapter-request.base-accepts-only-https-or-loopback-http: clause 1: a base that is not https or loopback http is refused with GITHUB_BASE_REFUSED [C7,#1429]', () => {
  const stubbedFetch = async () => ({ status: 200, json: async () => ({}) });
  for (const base of ['http://api.github.com', 'ftp://example.test', 'api.github.com', 'file:///tmp/x', 'http://localhost.example.test']) {
    assert.throws(() => createGithubAdapter(stubbedFetch, { base }), (error) => error.name === 'Refused' && error.code === 'GITHUB_BASE_REFUSED', `refuses ${base}`);
  }
  for (const base of ['https://api.github.com', 'http://localhost:9', 'http://127.0.0.1:9', 'http://[::1]:9']) {
    assert.doesNotThrow(() => createGithubAdapter(stubbedFetch, { base }), `accepts ${base}`);
  }
});

test('github.io-adapter-request.base-forwards-the-callers-signal: clause 1: a caller signal passed to request reaches the fetch, and no signal adds no signal option [C7,#1429]', async () => {
  const seen = [];
  const stubbedFetch = async (_url, init) => { seen.push(init); return { status: 200, json: async () => ({}) }; };
  const adapter = createGithubAdapter(stubbedFetch);
  const controller = new AbortController();
  await adapter.request('/user', { signal: controller.signal });
  await adapter.request('/user');
  assert.equal(seen[0].signal, controller.signal);
  assert.equal('signal' in seen[1], false);
});

test('github.io-adapter-request.base-front-door-passes-the-contract: clause 2: createGithubAdapter and createFakeGithubAdapter imported from packages/github/index.js both pass the existing contract table [C7,#1429]', async () => {
  const { all } = forms();
  assert.deepEqual(all.map(([form]) => form), ['real', 'fake']);
  for (const [form, adapter] of all) {
    assert.deepEqual(await adapter.request('/repos/owner/name'), REPOSITORY, `${form} form answers { status, body }`);
    await assert.rejects(adapter.request('repos/owner/name'), (error) => error.code === 'GITHUB_PATH_RELATIVE', `${form} form refuses a relative path`);
  }
});

test('github.io-adapter-request.method-sends-method-headers-body: clause 1: request(path, { method, headers, body, signal }) reaches fetch with redirect manual, and the response gives { status, headers, body } with the Link header readable [C7,#1429]', async () => {
  const seen = [];
  const stubbedFetch = async (url, init) => {
    seen.push({ url, init });
    return { status: 201, headers: new Headers({ 'content-type': 'application/json', link: '<https://api.github.com/user/repos?page=2>; rel="next"' }), json: async () => ({ ok: true }), text: async () => 'unused' };
  };
  const controller = new AbortController();
  const answer = await createGithubAdapter(stubbedFetch).request('/repos/owner/name/statuses/abc', { method: 'POST', headers: { authorization: 'token t' }, body: '{"state":"success"}', signal: controller.signal });
  assert.equal(seen[0].url, 'https://api.github.com/repos/owner/name/statuses/abc');
  assert.equal(seen[0].init.method, 'POST');
  assert.deepEqual(seen[0].init.headers, { accept: 'application/vnd.github+json', authorization: 'token t' });
  assert.equal(seen[0].init.body, '{"state":"success"}');
  assert.equal(seen[0].init.redirect, 'manual');
  assert.equal(seen[0].init.signal, controller.signal);
  assert.equal(answer.status, 201);
  assert.match(answer.headers.link, /rel="next"/u);
  assert.deepEqual(answer.body, { ok: true });
});

test('github.io-adapter-request.method-body-parses-json-only-for-json: clause 1: a response body is parsed as JSON only when its content type says json, else it is text [C7,#1429]', async () => {
  const reply = (type, text) => async () => ({ status: 200, headers: new Headers({ 'content-type': type }), json: async () => JSON.parse(text), text: async () => text });
  assert.deepEqual((await createGithubAdapter(reply('application/json; charset=utf-8', '{"a":1}')).request('/x')).body, { a: 1 });
  assert.equal((await createGithubAdapter(reply('application/x-www-form-urlencoded', 'a=1&b=2')).request('/x')).body, 'a=1&b=2');
});

test('github.io-adapter-request.method-fake-answers-by-method-and-path: clause 2: createFakeGithubAdapter answers the same contract table keyed by method and path, and a GET with no options behaves as today [C7,#1429]', async () => {
  const fake = createFakeGithubAdapter({
    '/repos/owner/name': REPOSITORY,
    'POST /repos/owner/name/statuses/abc': { status: 201, headers: { link: 'x' }, body: { state: 'success' } },
  });
  assert.deepEqual(await fake.request('/repos/owner/name'), REPOSITORY, 'a GET with no options answers from the bare path');
  assert.deepEqual(await fake.request('/repos/owner/name/statuses/abc', { method: 'POST', body: '{}' }), { status: 201, headers: { link: 'x' }, body: { state: 'success' } });
  assert.equal((await fake.request('/repos/owner/name/statuses/abc')).status, 404, 'a GET does not hit the POST row');
  assert.equal((await fake.request('/repos/owner/name', { method: 'DELETE' })).status, 404, 'a method with no row is 404');
});

