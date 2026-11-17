/** With push.pinTooling on, a pre-push shard request carries the same tooling tree as the item gate's request for that commit [C7,#9373]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellRepo } from '../../../../../packages/store/tests/fixtures/cell.js';
import { gateShardRequest } from '../../../src/io/submit/pull.js';
import { pulledTooling } from '../../../src/io/submit/pull.js';
import { pushShardTooling } from '../../../src/io/submit/pull.js';

const shard = { index: 1, of: 2, files: ['a.test.js'], command: 'node --test a.test.js' };

test('cli.io-submit-push-shard-tooling.with-push-pintooling-on-the-shard-request: clause 1: with push.pinTooling on, the shard request carries the tooling tree the item gate carries for the same commit [C7,#9373]', t => {
  const { root, commit } = cellRepo(t, { real: true });
  const item = pulledTooling(root, commit).tooling;
  assert.match(item, /^[0-9a-f]{40}$/u, 'the item gate pins a tree');
  const request = gateShardRequest({ main: commit, source: commit, shard, ...pushShardTooling(root, commit, true) });
  assert.equal(request.tooling, item);
});

test('cli.io-submit-push-shard-tooling.an-unreadable-pin-leaves-the-request-without: clause 2: an unreadable pin leaves the request without a tooling field [C7,#9373]', t => {
  const { root } = cellRepo(t, { real: true });
  const missing = '0'.repeat(40);
  assert.deepEqual(pushShardTooling(root, missing, true), {});
  const request = gateShardRequest({ main: missing, source: missing, shard, ...pushShardTooling(root, missing, true) });
  assert.equal('tooling' in request, false);
});

test('cli.io-submit-push-shard-tooling.with-the-setting-off-the-request-is: clause 2: with the setting off the request is byte-identical to today\'s [C7,#9373]', t => {
  const { root, commit } = cellRepo(t, { real: true });
  const today = JSON.stringify(gateShardRequest({ main: commit, source: commit, shard }));
  const off = JSON.stringify(gateShardRequest({ main: commit, source: commit, shard, ...pushShardTooling(root, commit, false) }));
  assert.equal(off, today);
  assert.equal(JSON.parse(off).tooling, undefined);
});
