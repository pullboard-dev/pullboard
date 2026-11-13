/** A later independently checked item cannot hide an earlier unverified commit, and altered local ancestry cannot publish proof [B3,R3]. */
import assert from 'node:assert/strict';
import {
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  bridgeProject,
  bridgeProvider,
  landBridgeItems,
  landBridgeRepair,
  runBridgeCLI,
} from '../../tests/fixtures/bridge.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import * as store from '../../../../packages/store/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

test('a later verified item cannot hide an unreviewed commit and grafted ancestry publishes nothing [B3,R3]', async t => {
  const proven = bridgeProject(t);
  const entries = await landBridgeItems(proven, { independent: true });
  assert.ok(onBoard(proven, board => entries.every(entry => store.acceptedVerdict(board, store.getItem(board, entry.id)).assurance === 'independent')),
    'the positive uses actual CLI checks and immutable independently registered fixture parent receipts');
  const github = await bridgeProvider(t, proven);
  const opened = await runBridgeCLI(proven, 'publish', '--json');
  assert.equal(opened.code, 0, opened.err);
  const native = github.pulls[0];
  const latest = head => github.statuses.findLast(entry => entry.sha === head && entry.context === 'pullboard/verified-by-second-agent');
  assert.equal(latest(native.head.sha).state, 'success', 'recorded item merges, introduced commits and trusted companion are covered');
  assert.match(latest(native.head.sha).description, /independent/u);
  // A later independently checked item cannot hide an earlier unverified commit in the same PR.
  proven.git(proven.repo, 'commit', '--allow-empty', '-q', '-m', 'chore: unreviewed release bump');
  const unreviewed = proven.git(proven.repo, 'rev-parse', 'HEAD');
  const added = fixtureAdd(proven.run, proven.repo, 'web', 'independently checked later work', '--specs', 'G1',
    '--criterion', 'the later work remains correct', '--check', 'test ! -f RED', '--json');
  assert.equal(added.code, 0, added.err);
  const later = JSON.parse(added.out).item.item_id;
  landBridgeRepair(proven, later, 'web/three.js', { independent: true });
  const complete = await runBridgeCLI(proven, 'publish', '--json');
  assert.equal(complete.code, 0, complete.err);
  const proof = JSON.parse(complete.out).verification.find(entry => entry.number === native.number);
  assert.equal(proof.state, 'failure');
  assert.ok(proof.unverified.includes(unreviewed), 'every commit is checked, not only the newly verified head');
  assert.equal(latest(native.head.sha).state, 'failure');
  assert.equal(github.requests.some(request => request.path.endsWith('/merge') && request.method !== 'GET'), false);
  const grafts = join(proven.repo, '.git/info/grafts');
  writeFileSync(grafts, `${native.head.sha} ${proven.published}\n`);
  const beforeGrafts = github.statuses.length;
  try {
    const grafted = await runBridgeCLI(proven, 'publish', '--json');
    assert.notEqual(grafted.code, 0);
    assert.equal(JSON.parse(grafted.out).error.code, 'GIT_GRAFTS');
    assert.equal(github.statuses.length, beforeGrafts, 'altered local ancestry cannot publish new proof');
  } finally { rmSync(grafts); }
});
