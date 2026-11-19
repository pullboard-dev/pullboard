/** The GitHub request adapter's real form and fake form answer one contract suite [C7,#1429]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeGithubAdapter } from '../../../src/io/adapter/request.js';
import { createGithubAdapter } from '../../../src/io/adapter/request.js';

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
