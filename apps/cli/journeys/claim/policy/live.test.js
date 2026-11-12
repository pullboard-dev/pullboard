/** Claim, next and verify never refuse NO_POLICY for a policy change; a fresh claim frees a legacy pinned bar [B4,R2]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../../tests/fixtures/testkit.js';
import { openKitBoard } from '../../../tests/fixtures/testkit.js';

/** Require each actual native fixture command to finish successfully, with no NO_POLICY anywhere in its output. */
function clean(box, cwd, ...args) {
  const result = box.run(cwd, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err || result.out}`);
  assert.doesNotMatch(`${result.out}${result.err}`, /NO_POLICY/u, `${args.join(' ')} names no NO_POLICY`);
  return result;
}

/** Commit one change to main's pullboard.json, as the coordinator does. */
function commitPolicy(box, change, message) {
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  change(config);
  writeFileSync(file, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', message);
}

/** Read one item through the fixture's real SQLite board. */
function itemOf(box, id) {
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test reads that same file.
  const board = openKitBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  try { return store.getItem(board, id); } finally { store.closeBoard(board); }
}

/** Give item 1 the frozen bar the previous release wrote: the bar plus a pinned policy commit and verify policy. */
function pinLegacyPolicy(box) {
  const board = openKitBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    const item = store.getItem(board, 1);
    const commit = box.git(box.repo, 'rev-parse', 'HEAD');
    const text = JSON.stringify({ ...JSON.parse(item.item_frozen), policy: { version: 1, commit, verify: { policy: 'any', family: 'off' } } });
    store.refreeze(board, 1, { agentId: 'coordinator', freeze: () => ({ text, digest: createHash('sha256').update(text).digest('hex') }) });
    return createHash('sha256').update(text).digest('hex');
  } finally { store.closeBoard(board); }
}

/** A project with three web items; item 1 carries a legacy pinned policy, items 2 and 3 a bar-only freeze. */
function threeItems(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const sandbox = helpers.sandbox();
  sandbox.env.CODEX_THREAD_ID = 'live-policy-builder-session';
  const box = helpers.project('true', sandbox);
  for (const title of ['Legacy item', 'Fresh item', 'Third item']) {
    const added = fixtureAdd(box.run, box.repo, 'web', title, '--specs', 'G1', '--criterion', `${title} renders.`, '--check', 'true', '--route', 'strong');
    assert.equal(added.code, 0, added.err || added.out);
  }
  clean(box, box.repo, 'refreeze', '1');
  const legacyDigest = pinLegacyPolicy(box);
  assert.ok(JSON.parse(itemOf(box, 1).item_frozen).policy, 'item 1 starts with a pinned policy');
  return { helpers, box, legacyDigest };
}

test('clause 1: after 3 policy commits that change lanes and checks, every open item claims and verifies with no NO_POLICY [B4,R2]', t => {
  const { helpers, box, legacyDigest } = threeItems(t);
  commitPolicy(box, config => { config.lanes.web.specs = ['G1', 'G2']; config.lanes.ops = { owns: ['ops/'], specs: [] }; }, 'chore: widen web specs, add ops lane');
  commitPolicy(box, config => { config.check = { timeout: '10m' }; config.affectedTests = 'true'; config.gate = 'true && true'; }, 'chore: change checks');
  const commits = {};
  for (const id of [1, 2, 3]) {
    // Each item builds on main alone, so no submit stacks on another item still in review.
    box.git(box.web, 'switch', '-q', '-c', `build-${id}`, 'main');
    clean(box, box.web, 'claim', String(id));
    const committed = helpers.commitFile(box, box.web, `web/item-${id}.js`, `export const item = ${id};\n`, `feat(web): build item ${id} [G1]`);
    assert.equal(committed.status, 0, committed.failure ?? committed.stderr);
    commits[id] = box.git(box.web, 'rev-parse', 'HEAD');
    clean(box, box.web, 'submit', String(id), '--no-next');
  }
  const legacy = itemOf(box, 1);
  assert.equal(JSON.parse(legacy.item_frozen).policy, undefined, 'the fresh claim re-froze the legacy bar alone');
  assert.notEqual(legacy.item_frozen_digest, legacyDigest);
  commitPolicy(box, config => { config.lanes.web.owns = ['web/', 'site/']; config.lanes.ui = { owns: ['ui/'], specs: [] }; }, 'chore: grow web lane, add ui lane');
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, commits[1]);
  box.env.CODEX_THREAD_ID = 'live-policy-reviewer-session';
  const joined = joinFixtureSeat(box, reviewer, 'web');
  assert.equal(joined.code, 0, joined.err || joined.out);
  for (const id of [1, 2, 3]) {
    box.git(reviewer, 'switch', '-q', '--detach', commits[id]);
    clean(box, reviewer, 'verify', String(id), 'accept', '--note', 'Read the change against its frozen bar.', '--no-next');
    assert.equal(itemOf(box, id).item_verdict, 'ACCEPT', `#${id} accepted after the policy commits`);
  }
});

test('clause 1: next claims an item whose lane policy changed, and a renewal keeps its bar [B4,R2]', t => {
  const { box } = threeItems(t);
  commitPolicy(box, config => { config.lanes.web.specs = ['G1', 'G2']; config.lanes.ops = { owns: ['ops/'], specs: [] }; }, 'chore: change web specs, add ops lane');
  const next = clean(box, box.web, 'next');
  assert.doesNotMatch(next.out, /skipped #1/u, 'next no longer passes over a legacy pinned item');
  assert.match(next.out, /claimed #1: Legacy item/u);
  const claimed = itemOf(box, 1);
  assert.equal(JSON.parse(claimed.item_frozen).policy, undefined, 'the fresh claim re-froze the legacy bar alone');
  commitPolicy(box, config => { config.lanes.web.owns = ['web/', 'docs/']; }, 'chore: grow web lane');
  const renewed = clean(box, box.web, 'claim', '1');
  assert.match(renewed.out, /renewed #1/u);
  assert.equal(itemOf(box, 1).item_frozen_digest, claimed.item_frozen_digest, 'a renewal keeps the bar it holds');
});

test('clause 2: claim compares no lane policy, and refreeze drops a pinned policy instead of re-pinning one [B4,R2]', t => {
  const { box } = threeItems(t);
  commitPolicy(box, config => { config.lanes.web.specs = ['G1', 'G2']; config.lanes.web.owns = ['web/', 'site/']; }, 'chore: change web lane');
  const claimed = clean(box, box.web, 'claim', '1');
  assert.doesNotMatch(claimed.out, /policy re-frozen automatically/u, 'no lane-policy comparison runs at claim');
  clean(box, box.web, 'release', '1', '--reason', 'OTHER', '--note', 'refreeze next', '--no-next');
  pinLegacyPolicy(box);
  clean(box, box.repo, 'refreeze', '1');
  assert.equal(JSON.parse(itemOf(box, 1).item_frozen).policy, undefined, 'a refreeze is the bar alone');
});
