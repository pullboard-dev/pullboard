/** Publishing proposes only proven heads and observes a person's merge [B3,R3]. */
import assert from 'node:assert/strict';
import {
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  bridgeProject,
  gateHeads,
  bridgeProvider,
  landBridgeItems,
  landBridgeRepair,
  runBridgeCLI,
} from '../../tests/fixtures/bridge.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import * as store from '../../../../packages/store/index.js';
import { configFromSource } from '../../../../packages/config/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

test("clause 1: publish opens one pull request with each item's receipt and records the person's merge as the release [B3,R3,C7]", async t => {
  const box = bridgeProject(t);
  const entries = landBridgeItems(box);
  const provider = await bridgeProvider(t, box);
  const head = box.git(box.repo, 'rev-parse', 'main');
  const result = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(result.code, 0, result.err);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), box.published,
    'opt-in PR publishing must leave the protected remote main unchanged');
  assert.equal(provider.pulls.length, 1, 'one release proposal carries both accepted items');
  const pull = provider.pulls[0];
  assert.equal(pull.head.sha, head, 'the proposed branch is the exact head the whole project gate passed');
  assert.ok(gateHeads(box).includes(head));
  for (const entry of entries) {
    assert.ok(pull.body.includes(`#${entry.id}`));
    assert.ok(pull.body.includes(entry.commit));
    assert.ok(pull.body.includes('ACCEPT'));
    assert.ok(pull.body.includes('coordinator'));
  }
  assert.ok(pull.body.includes('darwin') || pull.body.includes('linux') || pull.body.includes('win32'));
  assert.ok(pull.body.includes(process.versions.node), 'receipt environment comes from actual proof');
  assert.equal(pull.body.includes(box.dir), false, 'machine paths do not become public PR text');
  assert.equal(pull.body.includes('private one remains correct'), false, 'private criteria are not projected');
  assert.equal(provider.requests.some(r => r.path.endsWith('/merge') && r.method !== 'GET'), false);
  const again = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(again.code, 0, again.err);
  assert.equal(provider.pulls.length, 1, 'an existing same-release PR is updated rather than duplicated');

  // A person performs a real private Git merge outside the product; the bridge only observes it.
  const person = join(box.dir, 'person');
  box.git(box.dir, 'clone', '-q', '--branch', 'main', box.remote, person);
  box.git(person, 'fetch', '-q', 'origin', pull.head.ref);
  box.git(person, 'merge', '-q', '--no-ff', '-m', 'chore: person merges reviewed proposal [G1]', 'FETCH_HEAD');
  box.git(person, 'push', '-q', 'origin', 'main');
  pull.state = 'closed'; pull.merged = true;
  pull.merge_commit_sha = box.git(person, 'rev-parse', 'HEAD');
  pull.merged_by = { login: 'fixture-person', type: 'User', id: 42 };
  const observed = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(observed.code, 0, observed.err);
  assert.equal(JSON.parse(observed.out).releases[0].recognizedPerson, true);
  assert.equal(JSON.parse(observed.out).releases[0].personApproval, false);
  const facts = onBoard(box, board => entries.flatMap(entry => store.itemThread(board, entry.id)
    .filter(fact => fact.type === 'fact').map(fact => fact.text)));
  for (const entry of entries) assert.ok(facts.some(text => text.includes(pull.html_url) && text.includes(pull.merge_commit_sha)),
    `item #${entry.id} retains the observed release fact`);
  assert.equal(provider.requests.some(r => r.path.endsWith('/merge') && r.method !== 'GET'), false,
    'no product path performs a GitHub merge');
});


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


test('publication modes are opt-in and invalid values refuse before a push [B3,R3]', () => {
  assert.equal(configFromSource('{}').publish?.pullRequest ?? false, false);
  for (const mode of [false, 'release', 'item']) {
    assert.equal(configFromSource(JSON.stringify({ publish: { pullRequest: mode } })).publish.pullRequest, mode);
  }
  for (const value of [true, 'auto-merge', null]) {
    const publish = value && typeof value === 'object' ? value : { pullRequest: value };
    assert.throws(() => configFromSource(JSON.stringify({ publish })), { code: 'BAD_CONFIG' });
  }
  // An unknown publish key is ignored with a note, not refused, since the forward-compatible reader of N26 landed (21798c7218 lineage).
  assert.equal(configFromSource(JSON.stringify({ publish: { pullRequest: 'release', merge: true } })).publish.pullRequest, 'release');
});

test('CI findings preserve the merged item and create one linked repair, then update the same PR [B2,R3]', async t => {
  const box = bridgeProject(t);
  const entries = landBridgeItems(box);
  const provider = await bridgeProvider(t, box);
  const first = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(first.code, 0, first.err);
  const pull = provider.pulls[0];
  const oldHead = pull.head.sha;
  provider.checks = [
    { id: 301, name: 'linux / behavior', head_sha: oldHead, status: 'completed', conclusion: 'failure',
      html_url: 'https://github.com/fixture/repository/actions/runs/301' },
    { id: 302, name: 'unattributed infrastructure', head_sha: oldHead, status: 'completed', conclusion: 'failure' },
    { id: 303, name: 'stale unrelated job', head_sha: '0'.repeat(40), status: 'completed', conclusion: 'failure' },
  ];
  provider.annotationsByRun[301] = [{ path: entries[0].file, annotation_level: 'failure' }];
  provider.annotationsByRun[302] = [];
  const observed = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(observed.code, 0, observed.err);
  const items = onBoard(box, board => store.listItems(board, { all: true }));
  const children = items.filter(item => item.item_parent_id === entries[0].id);
  assert.equal(children.length, 1);
  const repair = children[0];
  assert.equal(items.find(item => item.item_id === entries[0].id).item_status, 'verified');
  assert.equal(items.find(item => item.item_id === entries[0].id).item_merged_commit !== null, true);
  assert.equal(items.filter(item => item.item_parent_id === entries[1].id).length, 0);
  const facts = onBoard(box, board => store.itemThread(board, entries[0].id));
  assert.ok(facts.some(fact => fact.type === 'fact' && fact.text.includes('linux / behavior') && fact.text.includes('/runs/301')));
  assert.ok(JSON.parse(observed.out).unattributed.some(job => job.job === 'unattributed infrastructure'));
  assert.equal((await runBridgeCLI(box, 'publish', '--json')).code, 0);
  assert.equal(onBoard(box, board => store.listItems(board, { all: true })).filter(item => item.item_parent_id === entries[0].id).length, 1,
    'polling the same failing run creates no duplicate child');
  landBridgeRepair(box, repair.item_id, entries[0].file);
  provider.checks = [];
  const updated = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(updated.code, 0, updated.err);
  assert.equal(provider.pulls.length, 1);
  assert.notEqual(pull.head.sha, oldHead, 'the actual newly proven repair head updates the original PR');
  assert.ok(pull.body.includes(`#${repair.item_id}`));
  assert.ok(gateHeads(box).includes(pull.head.sha));
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), box.published);
});
