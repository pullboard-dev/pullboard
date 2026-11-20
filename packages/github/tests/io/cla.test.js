/** @pullboard-test-input packages/github/src/io/cla.js */
/** The CLA check's network half reads a pull request and posts its status through the GitHub adapter [C7,#11435]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { createFakeGithubAdapter } from '../../src/io/adapter/request.js';
import { loadPullRequest } from '../../src/io/cla.js';
import { postStatus } from '../../src/io/cla.js';
import { runCla } from '../../src/io/cla.js';

const REPO = '/repos/o/r';
const files = privateFixtureFiles('github-cla-');
files.write('event.json', JSON.stringify({ pull_request: { number: 7, head: { sha: 'abc123' } } }));
const eventFile = join(files.root, 'event.json');

/** An environment adapter over a plain table, with the default the real one takes. */
const environment = (table) => ({ get: (name, fallback) => table[name] ?? fallback });
const ENVIRONMENT = environment({ GITHUB_EVENT_PATH: eventFile, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' });
const commit = (n) => ({ sha: `c${n}`, author: { login: 'ann', id: 1 }, commit: { message: `m${n}` }, parents: [] });
const comment = (n) => ({ id: n, user: { id: 1, login: 'ann' }, body: `b${n}`, html_url: `u${n}`, created_at: 'then' });
const page = (make, from, count) => Array.from({ length: count }, (_, i) => make(from + i));

test('github.io-cla.loads-commits-and-comments-through-the-adapter: clause 1: two pages of 100 then a short page load as the gate shape, and a fixture file answers live false with no request [C7]', async () => {
  const adapter = createFakeGithubAdapter({
    [`${REPO}/pulls/7/commits?per_page=100&page=1`]: { status: 200, body: page(commit, 0, 100) },
    [`${REPO}/pulls/7/commits?per_page=100&page=2`]: { status: 200, body: page(commit, 100, 2) },
    [`${REPO}/issues/7/comments?per_page=100&page=1`]: { status: 200, body: page(comment, 0, 100) },
    [`${REPO}/issues/7/comments?per_page=100&page=2`]: { status: 200, body: page(comment, 100, 1) },
  });
  const pr = await loadPullRequest(adapter, ENVIRONMENT);
  assert.deepEqual(Object.keys(pr).sort(), ['comments', 'commits', 'head', 'live']);
  assert.equal(pr.live, true);
  assert.equal(pr.head, 'abc123');
  assert.equal(pr.commits.length, 102);
  assert.deepEqual(pr.commits[101], { sha: 'c101', login: 'ann', id: 1, message: 'm101', parents: [] });
  assert.equal(pr.comments.length, 101);
  assert.deepEqual(pr.comments[100], { id: 100, user_id: 1, login: 'ann', body: 'b100', url: 'u100', created_at: 'then' });

  files.write('pr.json', JSON.stringify({ commits: [], comments: [], head: 'x' }));
  const refusing = { request: async () => { throw new Error('no request expected'); } };
  assert.deepEqual(await loadPullRequest(refusing, environment({ CLA_PR_FILE: join(files.root, 'pr.json') })), { commits: [], comments: [], head: 'x', live: false });
});

test('github.io-cla.loads-commits-and-comments-through-the-adapter: clause 1: a non-ok page throws the GitHub API status for the path [C7]', async () => {
  await assert.rejects(loadPullRequest(createFakeGithubAdapter({}), ENVIRONMENT), /GitHub API 404 for \/repos\/o\/r\/pulls\/7\/commits/u);
});

test('github.io-cla.posts-the-status-through-the-adapter: clause 2: success and failure post to the head with context CLA and a 140 character description, and a refusal never throws [C7]', async () => {
  const sent = [];
  const recording = { request: async (path, options) => { sent.push([path, options]); return { status: 201, body: {} }; } };
  await postStatus(recording, { live: true, head: 'abc123' }, true, 'x'.repeat(200), ENVIRONMENT);
  await postStatus(recording, { live: true, head: 'abc123' }, false, 'unsigned', ENVIRONMENT);
  assert.equal(sent[0][0], `${REPO}/statuses/abc123`);
  assert.equal(sent[0][1].method, 'POST');
  assert.deepEqual(sent[0][1].headers, { authorization: 'Bearer t' });
  assert.deepEqual(JSON.parse(sent[0][1].body), { state: 'success', context: 'CLA', description: 'x'.repeat(140) });
  assert.equal(JSON.parse(sent[1][1].body).state, 'failure');

  await postStatus({ request: async () => { throw new Error('read-only token'); } }, { live: true, head: 'h' }, true, 'ok', ENVIRONMENT);
  await postStatus(createFakeGithubAdapter({}), { live: true, head: 'h' }, true, 'ok', ENVIRONMENT);
  await postStatus(recording, { live: false, head: 'h' }, true, 'ok', ENVIRONMENT);
  assert.equal(sent.length, 2, 'a fixture run posts nothing');
});

test('github.io-cla.runs-with-injected-pure-half: clause 3: runCla calls the injected functions, exits 0 for a signed author and 1 for an unsigned one, and posts the status [C7]', async () => {
  assert.equal(readFileSync("packages/github/src/io/cla.js", 'utf8').includes('gate/'), false, 'cla.js never imports gate');
  files.write('pr-live.json', JSON.stringify({ commits: [{ login: 'ann' }], comments: [], head: 'h1' }));
  files.write('signatures.json', '{}');
  const seen = [];
  const evaluate = (pr, signatures) => { seen.push(['evaluate', pr.live, signatures]); return { problems: pr.commits[0].login === 'ann' ? [] : ['unsigned'] }; };
  const readSignatures = (path) => { seen.push(['read', path]); return 'sigs'; };
  const table = { CLA_PR_FILE: join(files.root, 'pr-live.json'), CLA_SIGNATURES_FILE: join(files.root, 'signatures.json') };
  const out = process.stdout.write;
  const err = process.stderr.write;
  const before = process.exitCode;
  const written = [];
  process.stdout.write = (text) => { written.push(text); return true; };
  process.stderr.write = (text) => { written.push(text); return true; };
  try {
    process.exitCode = 0;
    await runCla({ adapter: createFakeGithubAdapter({}), environment: environment(table), evaluate, readSignatures });
    assert.equal(process.exitCode, 0);
    files.write('pr-bad.json', JSON.stringify({ commits: [{ login: 'bob' }], comments: [], head: 'h2' }));
    await runCla({ adapter: createFakeGithubAdapter({}), environment: environment({ ...table, CLA_PR_FILE: join(files.root, 'pr-bad.json') }), evaluate, readSignatures });
    assert.equal(process.exitCode, 1);
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    process.exitCode = before;
  }
  assert.deepEqual(seen, [['read', table.CLA_SIGNATURES_FILE], ['evaluate', false, 'sigs'], ['read', table.CLA_SIGNATURES_FILE], ['evaluate', false, 'sigs']]);
  assert.match(written.join(''), /unsigned/u);

  const sent = [];
  const recording = { request: async (path, options) => { sent.push([path, JSON.parse(options.body)]); return { status: 201, body: {} }; } };
  files.write('event2.json', JSON.stringify({ pull_request: { number: 7, head: { sha: 'abc123' } } }));
  const live = environment({ GITHUB_EVENT_PATH: join(files.root, 'event2.json'), GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't', CLA_SIGNATURES_FILE: table.CLA_SIGNATURES_FILE });
  const listing = { request: async (path, options) => (options?.method === 'POST' ? recording.request(path, options) : { status: 200, body: [] }) };
  process.stdout.write = () => true;
  try { await runCla({ adapter: listing, environment: live, evaluate: () => ({ problems: [] }), readSignatures }); } finally { process.stdout.write = out; }
  assert.deepEqual(sent, [[`${REPO}/statuses/abc123`, { state: 'success', context: 'CLA', description: 'CLA satisfied' }]]);
});
