/** A pulled land job's handler runs under a gate job's environment: the runner's own install rides as PULLBOARD_RUNNER_TOOLS (#7816) [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';

// The land handler is stubbed, so the runner's git is never asked for anything.
const pullGit = async () => ({ status: 0, stdout: '', stderr: '' });

test('drive.handled.c-7816-a-land-handlers-environment: #7816: a land handler\'s environment names this runner\'s Pullboard install, as a gate job\'s does, so a trusted step can judge a non-Pullboard fixture [C7]', async t => {
  const { root } = privateFixtureFiles('pullboard-handled-env-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let claimed = false;
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    if (call.action === 'claim') {
      const claim = claimed ? null : { job: 'land:7816', kind: 'land', needs: [], run: [], candidate: null, base: null, attempt: 1, token: 't' };
      claimed = true;
      return { status: 200, json: async () => ({ trunk: 'unused', claim }) };
    }
    return { status: 200, json: async () => (call.action === 'renew' ? { renewed: true } : { recorded: true }) };
  };
  const seen = [];
  const handlers = { land: async (_claim, { env }) => { seen.push(env.PULLBOARD_RUNNER_TOOLS); return { outcome: 'red', detail: 'stop here' }; } };
  await serveRunner({ git: pullGit, board: 'http://board.invalid/api/v1/boards/b?k=x', runner: 'r-env', capabilities: [], cache: root, once: true, fetchImpl, handlers, trunkPack: async () => {} });
  assert.equal(seen.length, 1, 'the handler ran once');
  assert.ok(seen[0] && existsSync(join(seen[0], 'packages/items/index.js')), `the handler's PULLBOARD_RUNNER_TOOLS is a Pullboard install: ${seen[0]}`);
});
