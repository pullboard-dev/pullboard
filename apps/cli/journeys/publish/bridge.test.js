/** Publishing proposes only proven heads and observes a person's merge [B3,R3]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  bridgeProject,
  gateHeads,
  bridgeProvider,
  landBridgeItems,
  runBridgeCLI,
} from '../../tests/fixtures/bridge.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import * as store from '../../../../packages/store/index.js';
import { configFromSource } from '../../../../packages/config/index.js';

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
