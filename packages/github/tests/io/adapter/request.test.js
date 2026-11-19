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
