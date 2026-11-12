/** A pull request carries a second-agent verified status; an outside one reads not verified [B3,R3]. */
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

test('a pull request carries a verified-by-a-second-agent status and an outside pull request reads not verified [B3,R3]', async t => {
  const box = bridgeProject(t);
  landBridgeItems(box);
  const provider = await bridgeProvider(t, box);
  const published = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(published.code, 0, published.err);
  const pull = provider.pulls[0];
  const status = provider.statuses.findLast(entry => entry.sha === pull.head.sha
    && entry.context === 'pullboard/verified-by-second-agent');
  assert.equal(status?.state, 'failure',
    'the actual PR must carry not verified while its unreceipted configuration/merge commits lack second-agent proof');
  assert.match(status.description, /^not verified/u);
  assert.match(status.description, /independence is unproven/u, 'procedural receipts are explicitly unproven');

  const proven = bridgeProject(t);
  const entries = landBridgeItems(proven, { independent: true });
  assert.ok(onBoard(proven, board => entries.every(entry => store.acceptedVerdict(board, store.getItem(board, entry.id)).assurance === 'independent')),
    'the positive uses actual CLI checks and immutable independently registered fixture parent receipts');
  const github = await bridgeProvider(t, proven);
  const opened = await runBridgeCLI(proven, 'publish', '--json');
  assert.equal(opened.code, 0, opened.err);
  const native = github.pulls[0];
  const latest = head => github.statuses.findLast(entry => entry.sha === head && entry.context === 'pullboard/verified-by-second-agent');
  assert.equal(latest(native.head.sha).state, 'success', 'recorded item merges, introduced commits and trusted companion are covered');
  assert.match(latest(native.head.sha).description, /independent/u);
  const beforeRepeat = github.statuses.length;
  assert.equal((await runBridgeCLI(proven, 'publish', '--json')).code, 0);
  assert.equal(github.statuses.length, beforeRepeat, 'unchanged receipt state does not create duplicate provider statuses');

  // The outside author has an ordinary Git clone, not a disabled Pullboard hook in the board checkout.
  const outsideRoot = join(proven.dir, 'outside-author');
  proven.git(proven.dir, 'clone', '-q', '--no-hardlinks', proven.repo, outsideRoot);
  proven.git(outsideRoot, 'remote', 'set-url', 'origin', proven.remote);
  // A real Git merge object can forge both trailers, but cannot manufacture its board landing.
  const forged = proven.git(outsideRoot, 'commit-tree', proven.git(outsideRoot, 'rev-parse', 'HEAD^{tree}'),
    '-p', native.head.sha, '-p', proven.published, '-m', 'chore: outside wrapper',
    '-m', `Pullboard-Item: #${entries[0].id}\nPullboard-Companion: #${entries[0].id}`);
  proven.git(outsideRoot, 'push', '-q', 'origin', `${forged}:refs/pull/70/head`);
  const outside = { ...structuredClone(native), number: 70, head: { ref: 'outside-forged', sha: forged },
    user: { login: 'outside-author' }, updated_at: '2026-10-24T00:00:00Z' };
  github.pulls.push(outside);
  const collision = { ...structuredClone(native), number: 71, user: { login: 'outside-author' } };
  github.pulls.push(collision);
  const discovered = await runBridgeCLI(proven, 'publish', '--json');
  assert.equal(discovered.code, 0, discovered.err);
  assert.equal(latest(forged).state, 'failure');
  assert.equal(latest(native.head.sha).state, 'failure', 'an outside PR sharing a head cannot borrow the native PR green status');
  assert.ok(JSON.parse(discovered.out).verification.find(entry => entry.number === 70).intake.includes('pullboard intake'));
  collision.state = 'closed';
  const filed = await runBridgeCLI(proven, 'intake', 'https://github.com/fixture/repository/pull/70',
    '--lane', 'web', '--route', 'strong', '--criterion', 'the outside contribution behaves correctly', '--check', 'test ! -f RED', '--json');
  assert.equal(filed.code, 0, filed.err);
  const intake = JSON.parse(filed.out).item;
  assert.equal(intake.item_status, 'submitted', 'the bridge files outside work for another agent, without certifying it');
  assert.equal(intake.item_commit, forged);
  const reconciled = await runBridgeCLI(proven, 'publish', '--json');
  assert.equal(reconciled.code, 0, reconciled.err);
  const outsideProof = JSON.parse(reconciled.out).verification.find(entry => entry.number === 70);
  assert.equal(outsideProof.state, 'failure');
  assert.ok(outsideProof.unverified.includes(forged), 'a forged item or companion trailer cannot borrow an unrelated native receipt');
  assert.equal(latest(native.head.sha).state, 'success', 'closing the unverified sharing PR restores the independently proven head');

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
