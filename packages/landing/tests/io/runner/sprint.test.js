/** @pullboard-test-input source-cell landing */
/** The runner's Sprint proof ports run the commands a land job carries on a temp trunk [C7,#12228]. */
import assert from 'node:assert/strict';
import { existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runnerSprintPorts } from '../../../src/io/runner/sprint.js';
import { commandCheck } from '../../../src/io/runner/job.js';
import { sprintProof } from '../../../src/io/exact.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../../../gate/tests/fixtures/testkit.js';

const readdirCount = dir => readdirSync(dir).length;

const NODE = process.execPath;
const PASS = 'import { test } from "node:test";\ntest("ok", () => {});\n';
const FAIL = 'import { test } from "node:test";\ntest("broken", () => { throw new Error("boom"); });\n';

/** A temp trunk with one base commit holding cells packages/alpha and packages/beta, and a way to commit a tip on top of it. */
function trunk() {
  const graph = fixtureCommittedGraph('landing-sprint-');
  graph.put('packages/alpha/src/a.js', 'export const a = 1;\n');
  graph.put('packages/beta/src/b.js', 'export const b = 1;\n');
  const base = graph.commit();
  const tipWith = (changes) => {
    for (const [path, text] of Object.entries(changes)) graph.put(path, text);
    return graph.commit();
  };
  return { root: graph.root, base, tipWith };
}

const sprint = (over = {}) => ({ static: [NODE, '-e', 'process.exit(0)'], testCommand: [NODE, '--test'], testFiles: '\\.test\\.js$', ...over });

test('landing.runner-sprint.ports-run-payload-commands: clause 1: the ports list base..tip changes, run the static argv, and run a cell green with no test file and red naming the failing file [C7,#12228]', async () => {
  const t = trunk();
  try {
    const tip = t.tipWith({ 'packages/alpha/src/a.js': 'export const a = 2;\n', 'packages/beta/tests/b.test.js': FAIL });
    const ports = runnerSprintPorts(t.root, { base: t.base, tip, sprint: sprint(), check: commandCheck });
    assert.deepEqual((await ports.changedFiles()).sort(), ['packages/alpha/src/a.js', 'packages/beta/tests/b.test.js']);
    assert.equal(ports.pin(), tip);
    assert.equal((await ports.runStatic()).isGreen, true);
    const redStatic = runnerSprintPorts(t.root, { base: t.base, tip, sprint: sprint({ static: [NODE, '-e', 'process.exit(3)'] }), check: commandCheck });
    assert.equal((await redStatic.runStatic()).isGreen, false);
    assert.equal((await ports.runCell('packages/alpha')).isGreen, true);
    const red = await ports.runCell('packages/beta');
    assert.equal(red.isGreen, false);
    assert.deepEqual(red.files, ['packages/beta/tests/b.test.js']);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('landing.runner-sprint.proof-with-ports: clause 2: sprintProof over these ports is green for a passing change and red naming the cell for a change that breaks its own test [C7,#12228]', async () => {
  const t = trunk();
  try {
    const good = t.tipWith({ 'packages/alpha/src/a.js': 'export const a = 2;\n', 'packages/alpha/tests/a.test.js': PASS });
    const green = await sprintProof({ tree: 'tree-1' }, runnerSprintPorts(t.root, { base: t.base, tip: good, sprint: sprint(), check: commandCheck }));
    assert.equal(green.result, 'green');
    assert.deepEqual(green.cells, ['packages/alpha']);
    const bad = t.tipWith({ 'packages/alpha/tests/a.test.js': FAIL });
    const red = await sprintProof({ tree: 'tree-2' }, runnerSprintPorts(t.root, { base: good, tip: bad, sprint: sprint(), check: commandCheck }));
    assert.equal(red.result, 'red');
    assert.equal(red.failed, 'packages/alpha');
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

/** A test that is red the first time it runs and green after, keyed by a marker file outside the trunk. */
const flaky = marker => `import { test } from "node:test";\nimport { existsSync, writeFileSync } from "node:fs";\ntest("flaky", () => { if (existsSync(${JSON.stringify(marker)})) return; writeFileSync(${JSON.stringify(marker)}, "x"); throw new Error("first run"); });\n`;

test('landing.runner-sprint.red-file-reruns-once: clause 1: a red file whose rerun and base run are green settles as a flake, while a red rerun or a non-green base run refuses the proof [C7,RFC0011]', async () => {
  const t = trunk();
  const fx = privateFixtureFiles('sprint-marker-');
  const scratch = fx.root;
  try {
    const marker = join(scratch, 'm1');
    const base = t.tipWith({ 'packages/alpha/tests/f.test.js': flaky(join(scratch, 'base-marker')) });
    fx.write('base-marker', 'x');
    const tip = t.tipWith({ 'packages/alpha/tests/f.test.js': flaky(marker) });
    const ports = runnerSprintPorts(t.root, { base, tip, sprint: sprint(), check: commandCheck });
    const flake = await sprintProof({ tree: 'tree-f' }, ports);
    assert.equal(flake.result, 'green');
    assert.deepEqual(flake.flakes, [{ file: 'packages/alpha/tests/f.test.js', tree: 'tree-f' }]);
    assert.equal(existsSync(join(t.root, '.git', 'worktrees')) ? readdirCount(join(t.root, '.git', 'worktrees')) : 0, 0, 'the base worktree is removed afterward');

    const stillRed = t.tipWith({ 'packages/alpha/tests/f.test.js': FAIL });
    const redRerun = await sprintProof({ tree: 'tree-r' }, runnerSprintPorts(t.root, { base, tip: stillRed, sprint: sprint(), check: commandCheck }));
    assert.equal(redRerun.result, 'red');
    assert.equal(redRerun.rerun, 'red');

    const brokenBase = t.tipWith({ 'packages/alpha/tests/f.test.js': FAIL + "// base\n" });
    const freshMarker = join(scratch, 'm2');
    const flakyTip = t.tipWith({ 'packages/alpha/tests/f.test.js': flaky(freshMarker) });
    const redBase = await sprintProof({ tree: 'tree-b' }, runnerSprintPorts(t.root, { base: brokenBase, tip: flakyTip, sprint: sprint(), check: commandCheck }));
    assert.equal(redBase.result, 'red');
    assert.equal(redBase.rerun, 'green');
    assert.equal(redBase.mainReceipt.result, 'red');
  } finally { rmSync(t.root, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); }
});

test('landing.runner-sprint.empty-cell: clause 2: runCell for a cell with no test file returns green with zero files and the proof records that cell as run [C7,RFC0011]', async () => {
  const t = trunk();
  try {
    const tip = t.tipWith({ 'packages/alpha/src/a.js': 'export const a = 3;\n' });
    const ports = runnerSprintPorts(t.root, { base: t.base, tip, sprint: sprint(), check: commandCheck });
    assert.deepEqual(await ports.runCell('packages/alpha'), { isGreen: true, files: [] });
    const proof = await sprintProof({ tree: 'tree-e' }, ports);
    assert.equal(proof.result, 'green');
    assert.deepEqual(proof.cells, ['packages/alpha']);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});
