/**
 * Lanes (L1, L2) and the config they live in.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { configProblems, defaults, durationMs, loadConfig } from '../src/config.js';
import { isLane, laneNames, laneOf, outOfLane } from '../src/lanes.js';

const CONFIG = {
  ...defaults(),
  lanes: {
    web: { owns: ['apps/web/'] },
    ui: { owns: ['apps/web/src/views/', 'packages/design/'] },
    api: { owns: ['apps/api/'] },
  },
  shared: ['redteam/'],
};

test('the longest owned prefix decides a path\'s lane; unowned paths are the coordinator\'s [L2]', () => {
  assert.equal(laneOf(CONFIG, 'apps/web/src/server.js'), 'web');
  assert.equal(laneOf(CONFIG, 'apps/web/src/views/home.js'), 'ui');
  assert.equal(laneOf(CONFIG, 'README.md'), 'coordinator');
});

test('a lane may change its own paths and shared ones; the coordinator may change anything', () => {
  const paths = ['apps/web/a.js', 'apps/web/src/views/b.js', 'apps/api/c.js', 'redteam/d.test.js'];
  assert.deepEqual(outOfLane(CONFIG, 'web', paths), [
    "apps/web/src/views/b.js (ui's)",
    "apps/api/c.js (api's)",
  ]);
  assert.deepEqual(outOfLane(CONFIG, 'coordinator', paths), []);
});

test('lane names list the coordinator first [L1]', () => {
  assert.deepEqual(laneNames(CONFIG), ['coordinator', 'web', 'ui', 'api']);
  assert.ok(isLane(CONFIG, 'coordinator'));
  assert.ok(!isLane(CONFIG, 'all'));
});

test('a config with a bad lane refuses and names the field [L1]', () => {
  const problems = configProblems({ ...CONFIG, lanes: { Web: { owns: 'apps/' }, all: { owns: [] } } });
  assert.ok(problems.some((problem) => problem.includes('lane "Web"')));
  assert.ok(problems.some((problem) => problem.includes('lane "all"')));
  const fields = configProblems({ ...CONFIG, lanes: { web: { owns: 'apps/', specs: 'B', starts: 5 } } });
  for (const field of ['"owns" is a list', '"specs" is a list', '"starts" is text']) {
    assert.ok(fields.some((problem) => problem.includes(`lane "web": ${field}`)), `a well-named lane with a bad field is refused: ${field}`);
  }
  assert.ok(configProblems({ ...CONFIG, verify: 'anyone' }).some((problem) => problem.includes('"verify.policy"')));
});

test('config merges nested groups over the defaults, and leases read as durations', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-config-'));
  try {
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'npm test', commits: { maxHeader: 60 }, lease: '90m' }));
    const config = loadConfig(root);
    assert.equal(config.commits.maxHeader, 60);
    assert.deepEqual(config.commits.requireIds, ['feat', 'fix']);
    assert.equal(config.leaseMs, 90 * 60_000);
    assert.deepEqual(config.verify, { policy: 'any', family: 'off', reviewRatio: 3 });
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'npm test', verify: 'coordinator' }));
    assert.deepEqual(loadConfig(root).verify, { policy: 'coordinator', family: 'off', reviewRatio: 3 }, 'legacy verify strings remain valid');
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'npm test', verify: { family: 'require' } }));
    assert.deepEqual(loadConfig(root).verify, { policy: 'any', family: 'require', reviewRatio: 3 }, 'nested verify options merge over defaults');
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'npm test', verify: { family: 'sometimes' } }));
    assert.throws(() => loadConfig(root), /verify\.family.*off.*prefer.*require/);
    writeFileSync(join(root, 'pullboard.json'), '{ not json');
    assert.throws(() => loadConfig(root), /BAD_CONFIG/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(durationMs('2h'), 7_200_000);
  assert.equal(durationMs('1d'), 86_400_000);
  assert.throws(() => durationMs('soon'), /BAD_CONFIG/);
});

test('[Q1,V15] the review queue ratio is configurable and invalid values name their field', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-review-ratio-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ verify: { reviewRatio: 1.5 } }));
  assert.equal(loadConfig(root).verify.reviewRatio, 1.5);
  for (const reviewRatio of [0, -1, '3', null]) {
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ verify: { reviewRatio } }));
    assert.throws(() => loadConfig(root), { code: 'BAD_CONFIG', message: /verify\.reviewRatio.*positive number/u });
  }
});

test("a claim's lease is 2h unless pullboard.json says otherwise [B4]", () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-lease-'));
  try {
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'npm test' }));
    assert.equal(loadConfig(root).leaseMs, 2 * 3_600_000);
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'npm test', lease: '45m' }));
    assert.equal(loadConfig(root).leaseMs, 45 * 60_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


const policyFixtures = createE2eHelpers();
after(policyFixtures.cleanup);

/** Claim a real item before the coordinator moves one API path into its web lane. */
function reassignedPathFixture() {
  const box = policyFixtures.project('true');
  mkdirSync(join(box.repo, 'api'));
  writeFileSync(join(box.repo, 'api/shared.js'), 'original\n');
  box.git(box.repo, 'add', 'api/shared.js');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: create coordinator fixture path');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = box.run(box.repo, 'add', 'web', 'Update reassigned path', '--specs', 'G1',
    '--criterion', 'the reassigned path has the new content', '--check', 'true');
  assert.equal(added.code, 0, added.err);
  const claimed = box.run(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  const before = JSON.parse(box.run(box.web, 'show', '1', '--json').out);
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

test('refreeze picks up a lane change made after the claim [V2,L3]', () => {
  const { box, before, trunkPolicy } = reassignedPathFixture();
  const refused = box.run(box.web, 'submit', '1', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'OUTSIDE_LANE',
    'a landed lane change does not silently widen the frozen claim');
  const refreshed = box.run(box.repo, 'refreeze', '1');
  assert.equal(refreshed.code, 0, refreshed.err);
  const refrozen = JSON.parse(box.run(box.repo, 'show', '1', '--json').out);
  const originalFreeze = JSON.parse(before.item_frozen);
  const currentFreeze = JSON.parse(refrozen.item_frozen);
  assert.equal(currentFreeze.policy.commit, trunkPolicy,
    'explicit refreeze captures the coordinator trunk policy rather than the candidate or first claim');
  assert.notEqual(currentFreeze.policy.commit, originalFreeze.policy.commit);
  assert.deepEqual({ ...currentFreeze, policy: originalFreeze.policy }, originalFreeze,
    'a lane-only policy change keeps the criterion, title, check and cited rows unchanged');
  assert.equal(refrozen.item_status, 'open');
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const submitted = box.run(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const item = JSON.parse(box.run(box.web, 'show', '1', '--json').out);
  assert.equal(item.item_status, 'submitted');
  assert.equal(JSON.parse(item.item_frozen).policy.commit, trunkPolicy,
    'reclaim and submission retain the explicitly refreshed policy');
});

test('a claimed item keeps its policy until refreeze [V2,L3]', () => {
  const { box, before, trunkPolicy } = reassignedPathFixture();
  const renewed = box.run(box.web, 'claim', '1');
  assert.equal(renewed.code, 0, renewed.err);
  assert.equal(box.run(box.web, 'release', '1').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const reclaimed = JSON.parse(box.run(box.web, 'show', '1', '--json').out);
  assert.equal(reclaimed.item_frozen, before.item_frozen,
    'renewing, releasing and reclaiming keep the first claim policy and criterion bytes');
  assert.equal(reclaimed.item_frozen_digest, before.item_frozen_digest);
  assert.notEqual(JSON.parse(reclaimed.item_frozen).policy.commit, trunkPolicy);
  const refused = box.run(box.web, 'submit', '1', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'OUTSIDE_LANE',
    'submission still enforces the old ownership until an explicit coordinator refreeze');
});
