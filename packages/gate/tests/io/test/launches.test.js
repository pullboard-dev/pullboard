/** @pullboard-test-input test-tree */
/** @pullboard-world-pin reads the shipped cli-launches baseline and journey tree to prove the ratchet holds. */
/** The CLI-launch ratchet counts process launches per journey and lets them only fall [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cliLaunchSites } from '../../../src/io/test/launches.js';
import { cellTestProblems } from '../../../src/io/test/cells.js';
import { cliLaunchReport } from '../../../src/io/test/launches.js';
import { cliLaunchGrowth } from '../../../src/io/test/launches.js';
import { cliLaunchSplit } from '../../../src/io/test/launches.js';
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

test('clause 1: a box member counts by whether its helper starts a process, so renaming box.cli to box.inProcess keeps the count [C7]', () => {
  /** A local fixture whose member, named `name`, runs the CLI as a child process; the test calls it three times. */
  const spawning = name => [
    'function fixture() {',
    "  const launch = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd });",
    `  return { root, ${name}: launch };`,
    '}',
    'const box = fixture();',
    `box.${name}(box.root, 'show');`,
    `await box.${name}(box.root, 'next');`,
    `box.${name}(box.root, 'claim', '1');`,
  ].join('\n');
  assert.deepEqual(cliLaunchSites(spawning('cli'), PATH).map(row => row.line), [2, 6, 7, 8]);
  assert.deepEqual(cliLaunchSites(spawning('inProcess'), PATH).map(row => row.line), [2, 6, 7, 8], 'the renamed helper still spawns');
  const method = 'function fixture() { return { sweep() { return spawnSync(process.execPath, [BIN, \'run\']); } }; }\nconst box = fixture();\nbox.sweep();';
  assert.deepEqual(cliLaunchSites(method, PATH).map(row => row.line), [1, 3], 'a method member that spawns counts at each call');
  const wrapped = 'function fixture() {\n  const run = (...args) => runFixtureChild(process.execPath, [BIN, ...args]);\n  const json = (...args) => JSON.parse(run(...args).stdout);\n  return { json };\n}\nconst box = fixture();\nbox.json(\'show\');';
  assert.deepEqual(cliLaunchSites(wrapped, PATH).map(row => row.line), [2, 7], 'a helper that reaches a spawn through another closure counts');
});

test('clause 2: a helper that runs the CLI in-process is not counted, whatever its name [C7]', () => {
  const source = [
    'function fixture() {',
    "  const cli = (cwd, ...args) => runCliInProcess(args, { cwd });",
    "  const inProcess = async args => main([...args, '--json'], { cwd: root });",
    '  return { root, cli, inProcess, run: inProcess, sweep: () => runDueSentinels({ root }) };',
    '}',
    'const box = fixture();',
    "box.cli(box.root, 'show');",
    "await box.inProcess(['next']);",
    "await box.run(['resume']);",
    'await box.sweep();',
  ].join('\n');
  assert.deepEqual(cliLaunchSites(source, PATH), []);
});

test('clause 1: a runner handed its command counts only when the call names node or the CLI, and a kit box keeps its spawning members [C7]', () => {
  const runner = [
    'function fixture() {',
    "  const run = (cwd, command, args) => runFixtureChild(command, args, { cwd });",
    '  return { run };',
    '}',
    'const box = fixture();',
    "box.run(box.root, process.execPath, [BIN, 'whoami']);",
    "box.run(box.root, 'git', ['status']);",
  ].join('\n');
  assert.deepEqual(cliLaunchSites(runner, PATH).map(row => row.line), [6]);
  const kit = [
    "const run = () => nextReview(ctx, board);",
    "const box = helpers.project('true');",
    "box.run(box.web, 'claim', '1');",
    "await box.inProcess(box.web, 'show', '1');",
  ].join('\n');
  assert.deepEqual(cliLaunchSites(kit, PATH).map(row => row.line), [3], 'a closure never put on a box does not shadow the kit member');
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

test('clause 1: the report gives each file a pullboard CLI count and an other-child count, with both totals [C7,#5946]', () => {
  const sites = cliLaunchSites("box.run(a);\nspawnSync(process.execPath, ['--test', 'x.test.js']);\nexecFileSync('node', ['-e', 'x']);\nspawnSync(process.execPath, [BIN, 'show']);", PATH);
  assert.deepEqual(cliLaunchSplit(sites), { files: { [PATH]: { cli: 2, other: 2 } }, totals: { cli: 2, other: 2 } });
  assert.deepEqual(cliLaunchCounts(sites), { [PATH]: { launch: 4 } }, 'the ceilings still count both');
});

test('tighten drops a row measured at 0 [C7]', () => {
  const other = 'apps/cli/journeys/example/stale.test.js';
  const baseline = { [PATH]: { launch: 2 }, [other]: { launch: 3 } };
  const next = tightenCliLaunchBaseline(cliLaunchSites('box.run(a);', PATH), baseline);
  assert.deepEqual(next, { [PATH]: { launch: 1 } });
  assert.equal(other in next, false, 'the file measured at 0 loses its row');
});

test('tighten refuses to raise or add a row, naming the file [C7]', () => {
  const added = 'apps/cli/journeys/example/new.test.js';
  assert.throws(() => tightenCliLaunchBaseline(cliLaunchSites('box.run(a);\nbox.run(b);', PATH), { [PATH]: { launch: 1 } }), /main\.test\.js/u);
  assert.throws(() => tightenCliLaunchBaseline(cliLaunchSites('box.run(a);', added), { [PATH]: { launch: 1 } }), /new\.test\.js/u);
});

test('clause 1: the advice for a packages/ cell test names a helper in its own cell, one the cross-cell import rule allows [C7]', () => {
  const source = "const a = spawnSync(process.execPath, [BIN, 'show'], {});";
  const cellPath = 'packages/landing/tests/io/example.test.js';
  const [site] = cliLaunchSites(source, cellPath);
  assert.match(site.text, /packages\/landing\/tests\/fixtures\//u);
  // The suggested location is the cell's own, so importing from it passes the cross-cell rule.
  const own = "import { withProcessEnvironment } from '../fixtures/environment.js';";
  assert.deepEqual(cellTestProblems(cellPath, own), []);
  const other = "import { captureCommandInProcess } from '../../../../apps/cli/tests/fixtures/process.js';";
  assert.equal(cellTestProblems(cellPath, other).length, 1, 'the journey fixture is refused for a cell test');
  assert.match(cliLaunchSites(source, PATH)[0].text, /apps\/cli\/tests\/fixtures\/process\.js$/u, 'a journey still gets the CLI fixture');
});
