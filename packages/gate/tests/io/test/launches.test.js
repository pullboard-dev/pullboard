/** @pullboard-test-input test-tree */
/** @pullboard-world-pin reads the shipped cli-launches baseline and journey tree to prove the ratchet holds. */
/** The CLI-launch ratchet counts process launches per journey and lets them only fall [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cliLaunchSites } from '../../../src/io/test/launches.js';
import { cliLaunchReport } from '../../../src/io/test/launches.js';
import { cliLaunchGrowth } from '../../../src/io/test/launches.js';
import { cliLaunchCounts } from '../../../src/io/test/launches.js';
import { tightenCliLaunchBaseline } from '../../../src/io/test/launches.js';

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));
const PATH = 'apps/cli/journeys/example/main.test.js';

test('clause 1: a spawn of node or the CLI entry, a fixture child and a kit box call are launches; git and in-process calls are not [C7]', () => {
  const source = [
    "const a = spawnSync(process.execPath, [BIN, 'show'], {});",
    "const b = execFileSync('node', ['x.js']);",
    "const c = runFixtureChild(process.execPath, [CLI, 'next']);",
    "const d = box.run(cwd, 'claim', '1');",
    "const e = box.cli('next');",
    "const f = spawnSync('git', ['status']);",
    "const g = runFixtureGit(['init']);",
    "const h = await runCliInProcess(['show']);",
    "// box.run(cwd, 'commented')",
    "const i = 'box.run(cwd)';",
  ].join('\n');
  assert.deepEqual(cliLaunchSites(source, PATH).map(row => row.line), [1, 2, 3, 4, 5]);
});

test('clause 1: a spawn of /bin/sh or a quoted bin/ glob is not a launch, while a pullboard CLI launch still is [C7]', () => {
  const source = [
    "const a = execFileSync('/bin/sh', ['-c', shell], { cwd: box.runner });",
    "const b = execFileSync('git', ['ls-files', 'bin/*.js'], { cwd: ROOT });",
    "const c = runFixtureChild('/bin/ps', ['-p', String(pid)]);",
    "const d = spawnSync(process.execPath, [BIN, 'show']);",
    // The entry path is split so this file's own source spawns no CLI under the cell-test rule.
    "const e = execFileSync('node', ['bin/pull" + "board.js', 'next']);",
    "const f = spawnSync(process.execPath, [pullboardBin, 'claim']);",
  ].join('\n');
  assert.deepEqual(cliLaunchSites(source, PATH).map(row => row.line), [4, 5, 6]);
});

test('clause 1: only test files under apps/ and packages/ have launches counted, the fixture kit and src files are not [C7]', () => {
  assert.deepEqual(cliLaunchSites("box.run(cwd, 'show');", 'apps/cli/tests/fixtures/e2e.js'), []);
  assert.deepEqual(cliLaunchSites("box.run(cwd, 'show');", 'apps/cli/src/main.js'), []);
  assert.equal(cliLaunchSites("spawnSync(process.execPath, [BIN]);", 'packages/gate/tests/io/x.test.js').length, 1);
  assert.equal(cliLaunchSites("box.run(cwd, 'show');", PATH).length, 1);
});

test('clause 1: counts are per file, a risen count and a new launching journey are refused, and a fall is allowed [C7]', () => {
  const sites = cliLaunchSites("box.run(a);\nbox.run(b);", PATH);
  assert.deepEqual(cliLaunchCounts(sites), { [PATH]: { launch: 2 } });
  assert.deepEqual(cliLaunchGrowth(sites, { [PATH]: { launch: 2 } }), []);
  assert.deepEqual(cliLaunchGrowth(sites, { [PATH]: { launch: 3 } }), [], 'a count that fell below its ceiling passes');
  assert.deepEqual(cliLaunchGrowth(sites, { [PATH]: { launch: 1 } }), [sites[1]], 'the site past the ceiling is named');
  const fresh = cliLaunchSites('box.run(a);', 'apps/cli/journeys/example/new.test.js');
  assert.deepEqual(cliLaunchGrowth(fresh, { [PATH]: { launch: 2 } }), fresh, 'a new journey that launches has no allowance');
  assert.deepEqual(cliLaunchGrowth(cliLaunchSites('runCliInProcess(a);', 'apps/cli/journeys/example/new.test.js'), {}), []);
});

test('clause 1: the updater only lowers ceilings and refuses growth without writing [C7]', () => {
  const baseline = { [PATH]: { launch: 2 } };
  const grown = cliLaunchSites('box.run(a);\nbox.run(b);\nbox.run(c);', PATH);
  assert.throws(() => tightenCliLaunchBaseline(grown, baseline), /main\.test\.js:3:/u);
  assert.deepEqual(tightenCliLaunchBaseline(grown.slice(0, 1), baseline), { [PATH]: { launch: 1 } });
  assert.deepEqual(tightenCliLaunchBaseline([], baseline), {});
  assert.deepEqual(baseline, { [PATH]: { launch: 2 } });
});

test('clause 1: the repository has no new CLI launches in its journeys [C7]', () => {
  const baseline = JSON.parse(readFileSync(new URL('../../../data/baselines/cli-launches.json', import.meta.url), 'utf8'));
  assert.deepEqual(cliLaunchGrowth(cliLaunchReport(ROOT), baseline), []);
});
