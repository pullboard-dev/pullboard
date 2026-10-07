/**
 * Lanes (L1, L2) and the config they live in.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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

test('a config with a bad lane refuses and names the field', () => {
  const problems = configProblems({ ...CONFIG, lanes: { Web: { owns: 'apps/' }, all: { owns: [] } } });
  assert.ok(problems.some((problem) => problem.includes('lane "Web"')));
  assert.ok(problems.some((problem) => problem.includes('lane "all"')));
  assert.ok(configProblems({ ...CONFIG, verify: 'anyone' }).some((problem) => problem.includes('"verify"')));
});

test('config merges nested groups over the defaults, and leases read as durations', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-config-'));
  try {
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'npm test', commits: { maxHeader: 60 }, lease: '90m' }));
    const config = loadConfig(root);
    assert.equal(config.commits.maxHeader, 60);
    assert.deepEqual(config.commits.requireIds, ['feat', 'fix']);
    assert.equal(config.leaseMs, 90 * 60_000);
    writeFileSync(join(root, 'pullboard.json'), '{ not json');
    assert.throws(() => loadConfig(root), /BAD_CONFIG/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(durationMs('2h'), 7_200_000);
  assert.equal(durationMs('1d'), 86_400_000);
  assert.throws(() => durationMs('soon'), /BAD_CONFIG/);
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
