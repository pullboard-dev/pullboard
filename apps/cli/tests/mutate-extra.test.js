/** A test file outside the cell can run against each fault beside the cell's own tests, and the sample flag caps the faults [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { mutateCell } from '../src/io/mutate/run.js';
import { privateFixtureFiles } from './fixtures/child.js';
import { runFixtureSetupGit } from './fixtures/child.js';

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const CALC = 'export function add(a, b) {\n  return a + b;\n}\nexport function isAdult(age) {\n  return age >= 18;\n}\n';
const CELL_TEST = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from './calc.js';\ntest('add', () => { assert.equal(add(2, 3), 5); });\n";
const JOURNEY = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { isAdult } from '../cells/calc/calc.js';\ntest('adult', () => { assert.equal(isAdult(30), true); assert.equal(isAdult(3), false); });\n";
const BROKEN_JOURNEY = "import { test } from 'node:test';\ntest('red', () => { throw new Error('red'); });\n";

/** A committed repo with a cell whose own test never reaches isAdult, and journeys outside the cell. */
function fixture() {
  const repo = privateFixtureFiles('mutate-extra-').root;
  const tmp = privateFixtureFiles('mutate-extra-tmp-').root;
  dirs.push(repo, tmp);
  const options = { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } };
  runFixtureSetupGit(['init', '-q', '-b', 'main'], options);
  mkdirSync(join(repo, 'cells', 'calc'), { recursive: true });
  mkdirSync(join(repo, 'journeys'), { recursive: true });
  writeFileSync(join(repo, 'cells', 'calc', 'calc.js'), CALC);
  writeFileSync(join(repo, 'cells', 'calc', 'calc.test.js'), CELL_TEST);
  writeFileSync(join(repo, 'journeys', 'adult.test.js'), JOURNEY);
  writeFileSync(join(repo, 'journeys', 'broken.test.js'), BROKEN_JOURNEY);
  runFixtureSetupGit(['add', '-A'], options);
  runFixtureSetupGit(['commit', '-q', '-m', 'base'], options);
  return { repo, tmp };
}

/** Run the mutation check with the scratch folder pointed at a private one, then restore the environment. */
async function run(repo, tmp, options) {
  const saved = process.env.PULLBOARD_SCRATCH;
  process.env.PULLBOARD_SCRATCH = tmp;
  try { return await mutateCell(repo, 'cells/calc', { all: true, ...options }); } finally {
    if (saved === undefined) delete process.env.PULLBOARD_SCRATCH; else process.env.PULLBOARD_SCRATCH = saved;
  }
}

test('cli.mutate-extra.an-extra-test-outside-the-cell-runs: an extra test outside the cell runs against each fault, catching what the cell tests miss, and one red before is left out [C7]', async () => {
  const { repo, tmp } = fixture();
  const report = await run(repo, tmp, { extra: ['journeys/adult.test.js', 'journeys/broken.test.js'] });
  assert.deepEqual(report.redBefore, ['journeys/broken.test.js']);
  const adult = report.faults.find(fault => fault.line === 5 && fault.operator === 'comparison');
  assert.deepEqual(adult.caughtBy, ['journeys/adult.test.js'], 'only the journey reaches isAdult');
  const addFault = report.faults.find(fault => fault.line === 2);
  assert.deepEqual(addFault.caughtBy, ['calc.test.js']);
  assert.deepEqual(readdirSync(tmp), [], 'the copy is removed');
});

test('cli.mutate-extra.without-an-extra-the-cell-tests-alone: without an extra the cell tests alone score, and sample caps the faults seeded per source file [C7]', async () => {
  const { repo, tmp } = fixture();
  const alone = await run(repo, tmp, {});
  assert.ok(alone.faults.every(fault => !fault.caughtBy.some(file => file.startsWith('journeys/'))));
  assert.ok(alone.faults.length > 1);
  const sampled = await run(repo, tmp, { sample: 1 });
  assert.equal(sampled.faults.length, 1);
});

test('cli.mutate-extra.with-reach-a-fault-runs-only-the: with reach, a fault runs only the tests whose imports reach the seeded file, and a test reaching nothing seeded is never run [C7]', async () => {
  const { repo, tmp } = fixture();
  const reach = { 'cells/calc/calc.test.js': ['cells/calc/calc.js'], 'journeys/adult.test.js': ['cells/calc/calc.js'], 'journeys/broken.test.js': [] };
  const report = await run(repo, tmp, { extra: ['journeys/adult.test.js', 'journeys/broken.test.js'], reach });
  assert.deepEqual(report.redBefore, [], 'the red journey reaches no seeded file, so it is not even run');
  assert.deepEqual(report.tests.map(row => row.file).sort(), ['calc.test.js', 'journeys/adult.test.js']);
  const narrow = await run(repo, tmp, { extra: ['journeys/adult.test.js'], reach: { 'cells/calc/calc.test.js': ['cells/other/x.js'], 'journeys/adult.test.js': ['cells/calc/calc.js'] } });
  assert.ok(narrow.faults.every(fault => fault.caughtBy.every(file => file === 'journeys/adult.test.js')), 'the cell test is skipped when it does not reach the seeded file');
  assert.equal(narrow.tests.find(row => row.file === 'calc.test.js'), undefined);
});
