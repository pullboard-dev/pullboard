/** Drives the real CLI (hooks, claim, submit, refreeze) over lane policies and checks lane ownership, refusals and exit codes end to end [L1,L2,L3]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { configProblems } from '../../../../packages/config/index.js';
import { defaults } from '../../../../packages/config/index.js';
import { durationMs } from '../../../../packages/config/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { isLane } from '../../../../packages/seats/index.js';
import { laneNames } from '../../../../packages/seats/index.js';
import { laneOf } from '../../../../packages/seats/index.js';
import { outOfLane } from '../../../../packages/seats/index.js';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { specGateMoveOnly } from '../../../../packages/spec/index.js';
import { submissionPaths } from '../../../../packages/sandbox/index.js';
import { ownsNewFile } from '../../../../packages/sandbox/src/io/trusted/policy.js';
import { planRowChange } from '../../../../packages/commits/light.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { publishAcceptedCells } from '../../../../packages/landing/tests/fixtures/plan.js';

const CONFIG = {
  ...defaults(),
  lanes: {
    web: { owns: ['apps/web/'] },
    ui: { owns: ['apps/web/src/views/', 'packages/design/'] },
    api: { owns: ['apps/api/'] },
  },
  shared: ['redteam/'],
};

test('a lane commits only exact gate paths for its staged test rename [L3,B34]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/old.test.js'), 'export const fixture = true;\n');
  writeFileSync(join(box.repo, 'web/kept.test.js'), 'export const kept = true;\n');
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8').replace('gate: web test', 'gate: node web/old.test.js,  web/kept.test.js');
  writeFileSync(join(box.repo, 'SPEC.md'), spec);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: seed renamed gate fixture');
  box.git(box.web, 'merge', '--ff-only', 'main');
  const moved = spec.replace('web/old.test.js', 'web/new.test.js');
  writeFileSync(join(box.web, 'SPEC.md'), moved);
  box.git(box.web, 'add', 'SPEC.md');
  assert.equal(specGateMoveOnly(box.web, 'SPEC.md'), false, 'a gate edit without an actual staged rename stays foreign');
  box.git(box.web, 'mv', 'web/old.test.js', 'web/new.test.js');
  assert.equal(specGateMoveOnly(box.web, 'SPEC.md'), true);
  // A valid gate change never authorizes extra wording, headers, status, IDs or unrelated gates.
  for (const changed of [moved.replace('The page renders.', 'Different rule.'), moved + '\nextra prose\n', moved + '\n', moved + ' ',
    moved.replace('approved, must', 'draft, must'), moved.replace('- G1 ', '- G3 '),
    moved.replace('gate: api test', 'gate: true')]) {
    writeFileSync(join(box.web, 'SPEC.md'), changed);
    box.git(box.web, 'add', 'SPEC.md');
    assert.equal(specGateMoveOnly(box.web, 'SPEC.md'), false);
    const refused = await box.runLocal(box.web, 'hook', 'pre-commit');
    assert.equal(refused.code, 1, refused.out + refused.err);
    assert.match(refused.out + refused.err, /outside the web lane: SPEC\.md/u);
  }
  writeFileSync(join(box.web, 'SPEC.md'), moved);
  box.git(box.web, 'add', 'SPEC.md');
  // Process-level case: a real git commit runs the installed pre-commit hook as its own process.
  const committed = runFixtureChild('git', ['commit', '-q', '-m', 'test: move exact gate fixture'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
  assert.equal(committed.status, 0, committed.stdout + committed.stderr);
  assert.equal(specGateMoveOnly(box.web, 'SPEC.md', 'HEAD^', 'HEAD'), true);
  const base = box.git(box.web, 'rev-parse', 'HEAD^');
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  assert.ok(submissionPaths(box.web, { item_lane: 'web', item_claim_head: base,
    item_frozen: JSON.stringify({ policy: { commit: base } }) }, commit, { mainCommit: base }).includes('SPEC.md'),
  'the exact committed gate move also passes native submission ownership');
});

test('WRONG_LANE names a clean native lane checkout and the claim there retains its lane hook [L2,B13,N2]', async t => {
  const box = crossLaneFixture(t);
  const web = box.seat('claim-web', 'web', box.session);
  const api = box.seat('claim api', 'api', box.session);
  const id = box.add('api', 'Build only in the API lane');
  const wrong = await box.runAsLocal(box.session, web.root, 'claim', String(id), '--json');
  assert.equal(wrong.code, 1);
  const refusal = JSON.parse(wrong.out).error;
  assert.equal(refusal.code, 'WRONG_LANE');
  assert.equal(refusal.next, `cd '${api.root}' && pullboard claim ${id}`);
  assert.equal(box.json(await box.runLocal(box.repo, 'show', String(id), '--json')).item_status, 'open');
  box.json(await box.runAsLocal(box.session, api.root, 'claim', String(id), '--json'));
  mkdirSync(join(api.root, 'api'), { recursive: true });
  writeFileSync(join(api.root, 'api/proof.js'), 'export const proof = true;\n');
  box.git(api.root, 'add', 'api/proof.js');
  const allowed = await box.runAsLocal(box.session, api.root, 'hook', 'pre-commit', '--json');
  assert.equal(allowed.code, 0, allowed.out + allowed.err);
  mkdirSync(join(api.root, 'web'), { recursive: true });
  writeFileSync(join(api.root, 'web/forbidden.js'), 'export const forbidden = true;\n');
  box.git(api.root, 'add', 'web/forbidden.js');
  const refused = await box.runAsLocal(box.session, api.root, 'hook', 'pre-commit', '--json');
  assert.equal(refused.code, 1);
  const hookRefusal = JSON.parse(refused.out).error;
  assert.equal(hookRefusal.code, 'COMMAND_FAILED', 'the native hook returns a nonzero command result rather than throwing a board refusal');
  assert.match(hookRefusal.message, /outside the api lane: web\/forbidden\.js \(web's\); shout its owner instead/u);
});

const policyFixtures = createE2eHelpers();
after(policyFixtures.cleanup);

/**
 * Assert a green submit routed only foreign paths to their owner: the builder is freed and nothing is submitted (B3,L1,V4).
 *
 * Why: ownership routing (814a7def2a) replaced the immediate OUTSIDE_LANE refusal for proved foreign paths; the owner decides.
 */
async function assertWaitsOnOwner(box, id, submitted, owner, paths, label = '') {
  assert.equal(submitted.code, 0, `${label} ${submitted.out}${submitted.err}`);
  const waiting = JSON.parse(submitted.out).waitingOwner;
  assert.deepEqual(waiting.owners, [owner], label);
  for (const path of paths) assert.equal(waiting.paths.includes(path), true, `${label} ${path}`);
  const item = JSON.parse((await box.runLocal(box.repo, 'show', String(id), '--json')).out);
  assert.equal(item.item_status, 'open', label);
  assert.equal(item.item_commit, null, `${label}: owner waiting is not a submission`);
  assert.match(item.item_hold_reason, /^waiting on ownership /u, label);
}

/** Claim a real item before the coordinator moves one API path into its web lane. */
async function reassignedPathFixture() {
  const box = policyFixtures.project('true');
  mkdirSync(join(box.repo, 'api'));
  writeFileSync(join(box.repo, 'api/shared.js'), 'original\n');
  box.git(box.repo, 'add', 'api/shared.js');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: create coordinator fixture path');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Update reassigned path', '--specs', 'G1',
    '--criterion', 'the reassigned path has the new content', '--check', 'true', '--route', 'strong');
  assert.equal(added.code, 0, added.err);
  const claimed = await box.runLocal(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  const before = JSON.parse((await box.runLocal(box.web, 'show', '1', '--json')).out);
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.web.owns.push('api/shared.js');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: reassign fixture path to web');
  const trunkPolicy = box.git(box.repo, 'rev-parse', 'HEAD');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const committed = policyFixtures.commitFile(box, box.web, 'api/shared.js', 'changed\n',
    'feat(web): update reassigned fixture path [G1]');
  assert.equal(committed.status, 0, committed.failure ?? committed.stderr);
  return { box, before, trunkPolicy };
}

test('refreeze picks up a lane change made after the claim [V2,L3]', async () => {
  const { box, before, trunkPolicy } = await reassignedPathFixture();
  await assertWaitsOnOwner(box, 1, await box.runLocal(box.web, 'submit', '1', '--json'), 'api', ['api/shared.js'],
    'a landed lane change does not silently widen the frozen claim');
  const refreshed = await box.runLocal(box.repo, 'refreeze', '1');
  assert.equal(refreshed.code, 0, refreshed.err);
  const refrozen = JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out);
  const originalFreeze = JSON.parse(before.item_frozen);
  const currentFreeze = JSON.parse(refrozen.item_frozen);
  assert.equal(currentFreeze.policy, undefined, 'the refreeze holds the bar alone, no policy pin [B4]');
  assert.deepEqual(currentFreeze, originalFreeze,
    'a lane-only policy change keeps the criterion, title, check and cited rows unchanged');
  assert.equal(refrozen.item_status, 'open');
  const lifted = await box.runLocal(box.repo, 'hold', '1', '--off');
  assert.equal(lifted.code, 0, lifted.err + lifted.out);
  const reclaimed = await box.runLocal(box.web, 'claim', '1');
  assert.equal(reclaimed.code, 0, reclaimed.err + reclaimed.out);
  const submitted = await box.runLocal(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const item = JSON.parse((await box.runLocal(box.web, 'show', '1', '--json')).out);
  assert.equal(item.item_status, 'submitted');
  assert.equal(item.item_frozen_digest, refrozen.item_frozen_digest, 'reclaim and submission keep the bar digest');
});

test('a claimed item keeps its policy until refreeze [V2,L3]', async () => {
  const { box, before, trunkPolicy } = await reassignedPathFixture();
  const renewed = await box.runLocal(box.web, 'claim', '1');
  assert.equal(renewed.code, 0, renewed.err);
  await assertWaitsOnOwner(box, 1, await box.runLocal(box.web, 'submit', '1', '--json'), 'api', ['api/shared.js'],
    'submission still enforces the old ownership until an explicit coordinator refreeze');
  const lifted = await box.runLocal(box.repo, 'hold', '1', '--off');
  assert.equal(lifted.code, 0, lifted.err + lifted.out);
  // A changed lane policy is not a bar change: the re-claim succeeds and keeps the bar bytes [B4].
  const reclaim = await box.runLocal(box.web, 'claim', '1');
  assert.equal(reclaim.code, 0, reclaim.err + reclaim.out);
  assert.doesNotMatch(reclaim.err + reclaim.out, /NO_POLICY/u);
  const reclaimed = JSON.parse((await box.runLocal(box.web, 'show', '1', '--json')).out);
  assert.equal(reclaimed.item_frozen, before.item_frozen, 'the re-claim keeps the criterion bytes');
  assert.equal(reclaimed.item_frozen_digest, before.item_frozen_digest);
  assert.equal(JSON.parse(reclaimed.item_frozen).policy, undefined);
  assert.notEqual(trunkPolicy, before.item_claim_head);
});

test('submit and patch attach share frozen ownership and move together on refreeze [L2,L3,V2,V4]', async () => {
  const { box, before, trunkPolicy } = await reassignedPathFixture();
  const previous = before.item_claim_head;
  const author = JSON.parse((await box.runLocal(box.web, 'whoami', '--json')).out).id;
  const patchFile = join(box.dir, 'ownership.patch');
  writeFileSync(patchFile, [
    'diff --git a/api/shared.js b/api/shared.js',
    '--- a/api/shared.js',
    '+++ b/api/shared.js',
    '@@ -1 +1 @@',
    '-changed',
    '+patched',
    '',
  ].join('\n'));
  await assertWaitsOnOwner(box, 1, await box.runLocal(box.web, 'submit', '1', '--json'), 'api', ['api/shared.js']);
  const deniedAttach = await box.runLocal(box.repo, 'patch', 'attach', '1', patchFile,
    '--key', 'ownership', '--author', author, '--json');
  assert.equal(deniedAttach.code, 1, deniedAttach.err + deniedAttach.out);
  const error = JSON.parse(deniedAttach.out).error;
  assert.equal(error.code, 'OUTSIDE_LANE');
  assert.ok(error.message.includes(previous), 'the refusal names the frozen ownership commit');
  assert.ok(error.message.includes("api/shared.js (api's)"), 'the old policy owns the exact path');
  const unchanged = JSON.parse((await box.runLocal(box.repo, 'patch', 'list', '1', '--json')).out);
  assert.deepEqual(unchanged.patches, [], 'rejected ownership writes no companion');
  const refrozen = await box.runLocal(box.repo, 'refreeze', '1', '--json');
  assert.equal(refrozen.code, 0, refrozen.err + refrozen.out);
  const lifted = await box.runLocal(box.repo, 'hold', '1', '--off');
  assert.equal(lifted.code, 0, lifted.err + lifted.out);
  const reclaimed = await box.runLocal(box.web, 'claim', '1', '--json');
  assert.equal(reclaimed.code, 0, reclaimed.err + reclaimed.out);
  const submitted = await box.runLocal(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  const item = JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out);
  assert.equal(item.item_status, 'submitted');
  assert.equal(JSON.parse(item.item_frozen).policy, undefined, 'the bar carries no policy pin [B4]');
  const attached = await box.runLocal(box.repo, 'patch', 'attach', '1', patchFile,
    '--key', 'ownership', '--author', author, '--json');
  assert.equal(attached.code, 0, attached.err + attached.out);
  assert.equal(JSON.parse(attached.out).changed, true, 'the same author now owns this path under the refrozen policy');
});

/** A web item that merged main, after which main changed the same foreign file again. */
async function mergedMainFixture(title) {
  const box = policyFixtures.project('true');
  assert.equal((await fixtureAdd(box.runLocal, box.repo, 'web', title, '--specs', 'G1', '--criterion', 'merge of main stays in lane', '--check', 'true', '--route', 'strong')).code, 0);
  assert.equal((await box.runLocal(box.web, 'claim', '1')).code, 0);
  assert.equal(policyFixtures.commitFile(box, box.web, 'web/index.html', 'own work\n', 'feat(web): own change [G1]').status, 0);
  assert.equal(policyFixtures.commitFile(box, box.repo, 'coordinator.txt', 'main one\n', 'chore: main change one').status, 0);
  box.git(box.web, 'merge', '-q', '--no-edit', 'main');
  assert.equal(policyFixtures.commitFile(box, box.repo, 'coordinator.txt', 'main two\n', 'chore: main change two').status, 0);
  return box;
}

test('a merge of main whose foreign-lane files advanced again still submits [L3,V4]', async () => {
  const box = await mergedMainFixture('Merged main');
  const submitted = await box.runLocal(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
});

test('a real outside-lane edit after the merge of main is refused by name [L3,V4]', async () => {
  const box = await mergedMainFixture('Edit after merge');
  mkdirSync(join(box.web, 'api'), { recursive: true });
  writeFileSync(join(box.web, 'api/stray.js'), 'outside\n');
  policyFixtures.attackCommit(box, box.web);
  const submitted = await box.runLocal(box.web, 'submit', '1', '--json');
  await assertWaitsOnOwner(box, 1, submitted, 'api', ['api/stray.js']);
  assert.equal(JSON.parse(submitted.out).waitingOwner.paths.includes('coordinator.txt'), false, 'main-only files never count');
});

test('lane hook permits only an owned rename and its exact foreign import repoint [L3]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  mkdirSync(join(box.repo, 'api'), { recursive: true });
  writeFileSync(join(box.repo, 'web/old.js'), 'export const value = 1;\n');
  const before = "import { value } from '../web/old.js';\nexport const result = value;\n";
  writeFileSync(join(box.repo, 'api/view.js'), before);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: seed import fixture');
  box.git(box.web, 'merge', '--ff-only', 'main');
  box.git(box.web, 'mv', 'web/old.js', 'web/new.js');
  const view = join(box.web, 'api/view.js');
  writeFileSync(view, before.replace('old.js', 'other.js'));
  box.git(box.web, 'add', 'api/view.js');
  assert.equal((await box.runLocal(box.web, 'hook', 'pre-commit')).code, 1, 'unrelated path refuses');
  writeFileSync(view, before.replace('old.js', 'new.js').replace('result = value', 'result = 2'));
  box.git(box.web, 'add', 'api/view.js');
  assert.equal((await box.runLocal(box.web, 'hook', 'pre-commit')).code, 1, 'logic edit refuses');
  writeFileSync(view, before.replace('old.js', 'new.js'));
  box.git(box.web, 'add', 'api/view.js');
  const accepted = await box.runLocal(box.web, 'hook', 'pre-commit');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  const base = box.git(box.web, 'rev-parse', 'HEAD');
  box.git(box.web, 'commit', '-q', '-m', 'test: move module');
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  assert.ok(submissionPaths(box.web, { item_lane: 'web', item_claim_head: base,
    item_frozen: JSON.stringify({ policy: { commit: base } }) }, commit, { mainCommit: base }).includes('api/view.js'));
});

test('lane hook accepts a deleted shim repoint only to its exact body [L3]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  mkdirSync(join(box.repo, 'api'), { recursive: true });
  writeFileSync(join(box.repo, 'web/body.js'), 'export const value = 1;\n');
  writeFileSync(join(box.repo, 'web/shim.js'), "export { value } from './body.js';\n");
  const before = "import { value } from '../web/shim.js';\nexport const result = value;\n";
  writeFileSync(join(box.repo, 'api/view.js'), before);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: seed shim fixture');
  box.git(box.web, 'merge', '--ff-only', 'main');
  box.git(box.web, 'rm', 'web/shim.js');
  const view = join(box.web, 'api/view.js');
  writeFileSync(view, before.replace('shim.js', 'body.js').replace('result = value', 'result = 2'));
  box.git(box.web, 'add', 'api/view.js');
  assert.equal((await box.runLocal(box.web, 'hook', 'pre-commit')).code, 1, 'additional logic edit refuses');
  writeFileSync(view, before.replace('shim.js', 'body.js'));
  box.git(box.web, 'add', 'api/view.js');
  const accepted = await box.runLocal(box.web, 'hook', 'pre-commit');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  const base = box.git(box.web, 'rev-parse', 'HEAD');
  box.git(box.web, 'commit', '-q', '-m', 'test: remove shim');
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  assert.ok(submissionPaths(box.web, { item_lane: 'web', item_claim_head: base,
    item_frozen: JSON.stringify({ policy: { commit: base } }) }, commit, { mainCommit: base }).includes('api/view.js'));
});

/** Run git in a temporary repo with a fixed identity; fail loudly. */
function planGit(root, ...args) {
  const run = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

/** Plan files for one cell, before and after a creation row; blobs read like Git entries. */
function planBlobs(placements) {
  const blob = value => ({ mode: '100644', bytes: Buffer.from(JSON.stringify(value)) });
  const index = { cells: [{ file: 'packages/codemap/data/plan/01-x.json', name: 'x', order: 1 }] };
  const shard = paths => ({ order: 1, name: 'x', root: 'packages/x', paths });
  const before = { 'packages/codemap/data/plan/cells.json': blob(index), 'packages/codemap/data/plan/01-x.json': blob(shard([])) };
  const after = { 'packages/codemap/data/plan/cells.json': blob(index), 'packages/codemap/data/plan/01-x.json': blob(shard(placements)) };
  return { before: path => before[path], after: path => after[path] };
}

test('a plan row for a file the item created before a reclaim is accepted while main lacks it, and refused once main has it [L3,C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'lanes-plan-'));
  try {
    planGit(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'README.md'), 'base\n');
    planGit(root, 'add', '.');
    planGit(root, 'commit', '-q', '-m', 'base');
    const base = planGit(root, 'rev-parse', 'HEAD');
    planGit(root, 'switch', '-q', '-c', 'item');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/new.js'), 'export {};\n');
    planGit(root, 'add', '.');
    planGit(root, 'commit', '-q', '-m', 'feat(x): new file [G1]', '-m', 'Pullboard-Item: #7');
    const own = planGit(root, 'rev-parse', 'HEAD');
    const row = [['src/new.js', 'packages/x/src/core/new.js', 'rule']];
    const change = (snapshot) => planRowChange('packages/codemap/data/plan/01-x.json', {
      ...planBlobs(row), ownNewFile: path => ownsNewFile(root, { item_id: 7 }, own, snapshot, path),
    });
    assert.equal(change(base).allowed, true, 'absent on main, every adding commit is the item\'s own');
    planGit(root, 'switch', '-q', 'main');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/new.js'), 'export {};\n');
    planGit(root, 'add', '.');
    planGit(root, 'commit', '-q', '-m', 'feat(y): same file landed on main [G1]');
    assert.equal(change(planGit(root, 'rev-parse', 'main')).allowed, false, 'present on main');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Set up a real board and cells plan so submission exercises the frozen lane policy. */
async function nativePlanRowFixture(t, { mainFile } = {}) {
  const box = policyFixtures.project('true');
  if (process.env.PULLBOARD_RUNNER_PRELOAD) box.env.PULLBOARD_RUNNER_PRELOAD = process.env.PULLBOARD_RUNNER_PRELOAD;
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.web.owns.push('src/');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2));
  const indexPath = 'packages/codemap/data/plan/cells.json';
  const shardPath = 'packages/codemap/data/plan/01-x.json';
  const index = { version: 1, stays: [], cells: [{ file: shardPath, name: 'x', order: 1 }] };
  const shard = { order: 1, name: 'x', root: 'packages/x', paths: [], reexports: [], cuts: [] };
  mkdirSync(join(box.repo, 'packages/codemap/data/plan'), { recursive: true });
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  if (mainFile) writeFileSync(join(box.repo, mainFile), 'export {};\n');
  writeFileSync(join(box.repo, indexPath), JSON.stringify(index, null, 2) + '\n');
  writeFileSync(join(box.repo, shardPath), JSON.stringify(shard, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json', indexPath, shardPath, ...(mainFile ? [mainFile] : []));
  box.git(box.repo, 'commit', '-q', '-m', 'chore: seed native plan-row fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  await publishAcceptedCells(t, box.repo, box.git(box.repo, 'rev-parse', 'main').trim(), box.env.PULLBOARD_MACHINE_HOME);
  return { box, shardPath };
}

/** Add and claim a real web item for native plan-row submission coverage. */
async function nativePlanRowItem(box, title) {
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', title, '--specs', 'G1', '--criterion', 'the owned new file has a canonical plan row',
    '--check', 'true', '--route', 'strong', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  return id;
}

/** Commit the candidate's canonical plan row and retain item authorship in Git history. */
function commitPlanRow(box, id, shardPath, source) {
  const shard = JSON.parse(readFileSync(join(box.web, shardPath), 'utf8'));
  shard.paths.push([source, `packages/x/src/core/${source.slice('src/'.length)}`, 'rule']);
  writeFileSync(join(box.web, shardPath), JSON.stringify(shard, null, 2) + '\n');
  box.git(box.web, 'add', shardPath);
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): place owned new file [G1]', '-m', `Pullboard-Item: #${id}`);
}

test('native submit accepts a plan row for an item file after reclaim and refreeze while main lacks it [L3,C7,#2108]', async t => {
  const { box, shardPath } = await nativePlanRowFixture(t);
  const id = await nativePlanRowItem(box, 'Place an item-created source file');
  mkdirSync(join(box.web, 'src'), { recursive: true });
  writeFileSync(join(box.web, 'src/new.js'), 'export {};\n');
  box.git(box.web, 'add', 'src/new.js');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): create planned source [G1]', '-m', `Pullboard-Item: #${id}`);
  const ownCommit = box.git(box.web, 'rev-parse', 'HEAD');
  const released = await box.runLocal(box.web, 'release', String(id), '--reason', 'BLOCKED', '--note', 'reclaim after the item source commit', '--json');
  assert.equal(released.code, 0, released.err + released.out);
  const refrozen = await box.runLocal(box.repo, 'refreeze', String(id), '--json');
  assert.equal(refrozen.code, 0, refrozen.err + refrozen.out);
  const reclaimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(reclaimed.code, 0, reclaimed.err + reclaimed.out);
  assert.equal(JSON.parse((await box.runLocal(box.web, 'show', String(id), '--json')).out).item_claim_head, ownCommit,
    'the reclaim uses the item commit as its new base');
  commitPlanRow(box, id, shardPath, 'src/new.js');
  const submitted = await box.runLocal(box.web, 'submit', String(id), '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', String(id), '--json')).out).item_status, 'submitted');
});

test('native submit refuses a plan row for a file already present on main [L3,C7,#2108]', async t => {
  const { box, shardPath } = await nativePlanRowFixture(t, { mainFile: 'src/already-main.js' });
  const id = await nativePlanRowItem(box, 'Refuse a plan row for a main file');
  commitPlanRow(box, id, shardPath, 'src/already-main.js');
  // The plan shard is no web path, so ownership routing sends the row to its owner rather than landing it (814a7def2a).
  await assertWaitsOnOwner(box, id, await box.runLocal(box.web, 'submit', String(id), '--json'), 'coordinator', [shardPath]);
});

test('cross-lane import edits follow only same-item moves or removed forwarding shims [L3]', async () => {
  const { movedImportOnlyChange, movedImportTargets } = await import('../../../../packages/commits/src/logic/import-only-change.js');
  const diff = 'R100\0api/old.js\0api/new.js\0D\0api/shim.js\0';
  const moves = movedImportTargets(diff, path => path === 'api/shim.js' ? "export { value } from './new.js';\n" : null, path => path === 'api/new.js');
  const before = "import { value } from '../api/old.js';\nexport const result = value;\n";
  const after = before.replace('../api/old.js', '../api/new.js');
  assert.equal(movedImportOnlyChange(before, after, 'web/view.js', moves), true);
  assert.equal(movedImportOnlyChange(before, after.replace('result = value', 'result = 1'), 'web/view.js', moves), false);
  assert.equal(movedImportOnlyChange(before, before.replace('../api/old.js', '../api/other.js'), 'web/view.js', moves), false);
  const shim = before.replace('../api/old.js', '../api/shim.js');
  assert.equal(movedImportOnlyChange(shim, after, 'web/view.js', moves), true);
  const input = '/** @pullboard-test-input api/old.js */\nexport const ok = true;\n';
  assert.equal(movedImportOnlyChange(input, input.replace('api/old.js', 'api/new.js'), 'web/test.js', moves), true);
  const lookalike = `const text = "@pullboard-test-input api/old.js";\n`;
  assert.equal(movedImportOnlyChange(lookalike, lookalike.replace('api/old.js', 'api/new.js'), 'web/test.js', moves), false);
});

