/** A runner serve sends its host and runner folder with each claim and stops when the board answers RUNNER_DUPLICATE [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { testGit as pullGit } from '../../fixtures/git.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';

/** A private runner cache folder, removed after the test. */
function runnerCache(t) {
  const { root } = privateFixtureFiles('pullboard-claim-place-cache-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('drive.claim-place.claim-sends-place: clause 1: serveRunner posts place { host, root } with each claim action, root being its cache folder [test] [C7]', async t => {
  const cache = runnerCache(t);
  const claims = [];
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    if (call.action === 'claim') claims.push(call);
    return { status: 200, json: async () => ({ claim: null }) };
  };
  await serveRunner({ git: pullGit, board: BOARD, runner: 'r-place', capabilities: [], cache, once: true, fetchImpl, trunkPack: async () => {} });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].place.root, cache);
  assert.equal(claims[0].place.host, hostname().replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 40) || 'runner');
});

test('drive.claim-place.duplicate-ends-serve: clause 2: a claim answered with RUNNER_DUPLICATE ends serveRunner with that error and no job is run [test] [C7]', async t => {
  const cache = runnerCache(t);
  const calls = [];
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    calls.push(call.action);
    return { status: 409, json: async () => ({ error: { code: 'RUNNER_DUPLICATE', message: 'runner r-dup claims from the same host and runner folder as runner r-first' } }) };
  };
  const handlers = { gate: async () => { throw new Error('no job should run'); } };
  await assert.rejects(
    serveRunner({ git: pullGit, board: BOARD, runner: 'r-dup', capabilities: [], cache, fetchImpl, handlers, trunkPack: async () => {} }),
    error => error.code === 'RUNNER_DUPLICATE');
  assert.deepEqual(calls, ['claim'], 'one claim, no retry, no job call');
});
