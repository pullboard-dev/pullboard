/**
 * Lanes (L1, L2) and the config they live in: the pure cases. The cases that drive hooks, claims, submits and refreezes
 * through the real CLI live in apps/cli/journeys/lanes/main.test.js.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configProblems } from '../../../config/index.js';
import { defaults } from '../../../config/index.js';
import { durationMs } from '../../../config/index.js';
import { loadConfig } from '../../../config/index.js';
import { isLane } from '../../index.js';
import { laneNames } from '../../index.js';
import { laneOf } from '../../index.js';
import { outOfLane } from '../../index.js';

const CONFIG = {
  ...defaults(),
  lanes: {
    web: { owns: ['apps/web/'] },
    ui: { owns: ['apps/web/src/views/', 'packages/design/'] },
    api: { owns: ['apps/api/'] },
  },
  shared: ['redteam/'],
};

test('seats.lanes.longest-prefix-decides: the longest owned prefix decides a path\'s lane; unowned paths are the coordinator\'s [L2]', () => {
  assert.equal(laneOf(CONFIG, 'apps/web/src/server.js'), 'web');
  assert.equal(laneOf(CONFIG, 'apps/web/src/views/home.js'), 'ui');
  assert.equal(laneOf(CONFIG, 'README.md'), 'coordinator');
});

test('seats.lanes.who-may-change: a lane may change its own paths and shared ones; the coordinator may change anything [L2,L3]', () => {
  const paths = ['apps/web/a.js', 'apps/web/src/views/b.js', 'apps/api/c.js', 'redteam/d.test.js'];
  assert.deepEqual(outOfLane(CONFIG, 'web', paths), [
    "apps/web/src/views/b.js (ui's)",
    "apps/api/c.js (api's)",
  ]);
  assert.deepEqual(outOfLane(CONFIG, 'coordinator', paths), []);
});

test('seats.lanes.coordinator-first: lane names list the coordinator first [L1]', () => {
  assert.deepEqual(laneNames(CONFIG), ['coordinator', 'web', 'ui', 'api']);
  assert.ok(isLane(CONFIG, 'coordinator'));
  assert.ok(!isLane(CONFIG, 'all'));
});

test('seats.lanes.bad-lane-refuses: a config with a bad lane refuses and names the field [L1]', () => {
  const problems = configProblems({ ...CONFIG, lanes: { Web: { owns: 'apps/' }, all: { owns: [] } } });
  assert.ok(problems.some((problem) => problem.includes('lane "Web"')));
  assert.ok(problems.some((problem) => problem.includes('lane "all"')));
  const fields = configProblems({ ...CONFIG, lanes: { web: { owns: 'apps/', specs: 'B', starts: 5 } } });
  for (const field of ['"owns" is a list', '"specs" is a list', '"starts" is text']) {
    assert.ok(fields.some((problem) => problem.includes(`lane "web": ${field}`)), `a well-named lane with a bad field is refused: ${field}`);
  }
  assert.ok(configProblems({ ...CONFIG, verify: 'anyone' }).some((problem) => problem.includes('"verify.policy"')));
});

test('seats.lanes.config-merge-leases: config merges nested groups over the defaults, and leases read as durations [O2,B4,C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-config-'));
  try {
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'npm test', commits: { maxHeader: 60 }, lease: '90m' }));
    const config = loadConfig(root);
    assert.equal(config.commits.maxHeader, 60);
    assert.deepEqual(config.commits.requireIds, ['feat', 'fix']);
    assert.equal(config.leaseMs, 90 * 60_000);
    assert.deepEqual(config.verify, { policy: 'any', family: 'off', reviewRatio: 3, inspectClauses: true, failBefore: false, frozenTests: false, testAuthorSplit: false, folderTicks: false, titleTicks: false });
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'npm test', verify: 'coordinator' }));
    assert.deepEqual(loadConfig(root).verify, { policy: 'coordinator', family: 'off', reviewRatio: 3, inspectClauses: true, failBefore: false, frozenTests: false, testAuthorSplit: false, folderTicks: false, titleTicks: false }, 'legacy verify strings remain valid');
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'npm test', verify: { family: 'require' } }));
    assert.deepEqual(loadConfig(root).verify, { policy: 'any', family: 'require', reviewRatio: 3, inspectClauses: true, failBefore: false, frozenTests: false, testAuthorSplit: false, folderTicks: false, titleTicks: false }, 'nested verify options merge over defaults');
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'npm test', verify: { family: 'sometimes' } }));
    assert.throws(() => loadConfig(root), /verify\.family.*off.*prefer.*require/);
    for (const familyRelaxAt of [null, 'off', 2]) {
      writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'npm test', verify: { familyRelaxAt } }));
      assert.equal(loadConfig(root).verify.familyRelaxAt, familyRelaxAt);
    }
    for (const familyRelaxAt of [0, -1, 1.5, '2']) {
      writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'npm test', verify: { familyRelaxAt } }));
      assert.throws(() => loadConfig(root), /verify\.familyRelaxAt/);
    }
    writeFileSync(join(root, 'pullboard.json'), '{ not json');
    assert.throws(() => loadConfig(root), /BAD_CONFIG/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(durationMs('2h'), 7_200_000);
  assert.equal(durationMs('1d'), 86_400_000);
  assert.throws(() => durationMs('soon'), /BAD_CONFIG/);
});

test('seats.lanes.review-ratio-configurable: [Q1,V15] the review queue ratio is configurable and invalid values name their field', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-review-ratio-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ verify: { reviewRatio: 1.5 } }));
  assert.equal(loadConfig(root).verify.reviewRatio, 1.5);
  for (const reviewRatio of [0, -1, '3', null]) {
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ verify: { reviewRatio } }));
    assert.throws(() => loadConfig(root), { code: 'BAD_CONFIG', message: /verify\.reviewRatio.*positive number/u });
  }
});

test('seats.lanes.claim-lease-default: a claim\'s lease is 2h unless pullboard.json says otherwise [B4]', () => {
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
