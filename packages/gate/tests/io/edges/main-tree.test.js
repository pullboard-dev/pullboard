/** @pullboard-test-input packages/gate/src/io/edges.js packages/gate/src/io/edges/main-tree.js */
/** On a pull runner main's folder is a no-checkout clone, so the light-door check asks git whether the door is main's; a refusal always names its reason on stderr [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { fixture } from '../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../landing/tests/fixtures/plan.js';
import { cellsEdgeProblems } from '../../../src/io/edges.js';
import { importSpecifiers } from '../../../src/io/edges.js';
import { lightDoorProblems } from '../../../src/io/edges.js';
import { refuse } from '../../../src/io/edges.js';
import { doorMatchesMain } from '../../../src/io/edges/main-tree.js';

const DOOR = 'packages/kernel/light.js';
const LOOP = 'packages/kernel/src/loop.js';
const SLOW = 'let total = 0;\nfor (let i = 0; i < 4e8; i += 1) total += i;\nexport const launch = total;\n';

/** A main whose light door imports one slow module, kept as a pull runner keeps it: a no-checkout clone plus a job worktree. */
function runnerLayout(t) {
  const { root: origin, put } = fixture(t);
  put('packages/codemap/data/plan/cells.json', JSON.stringify({ cells: [{ file: 'packages/codemap/data/plan/cells/kernel.json' }] }));
  put('packages/codemap/data/plan/cells/kernel.json', JSON.stringify({ name: 'kernel', lightFrontDoor: DOOR }));
  put(DOOR, "export { launch } from './src/loop.js';\n");
  put(LOOP, SLOW);
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'door');
  const { root: base } = privateFixtureFiles('edges-main-runner-');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const shell = join(base, 'main'), job = join(base, 'job');
  git(base, 'clone', '-q', '--no-checkout', origin, shell);
  git(shell, 'worktree', 'add', '-q', '--detach', job, 'main');
  return { origin, put, shell, job };
}

test('a slow door that git shows unchanged from main is main\'s own door, so a no-checkout main never refuses it [C7]', async t => {
  const { shell, job } = runnerLayout(t);
  assert.equal(existsSync(join(shell, DOOR)), false, 'the clone holds no files');
  assert.equal(await doorMatchesMain(job, DOOR, importSpecifiers), true);
  assert.deepEqual(await lightDoorProblems(job), []);
});

test('main changing the door after the candidate forked is not the candidate\'s doing [C7]', async t => {
  const { origin, put, shell, job } = runnerLayout(t);
  put(LOOP, SLOW.replace('4e8', '5e8'));
  git(origin, 'commit', '-q', '-am', 'main moves on');
  git(shell, 'fetch', '-q', '--update-head-ok', 'origin', 'main:main');
  assert.equal(await doorMatchesMain(job, DOOR, importSpecifiers), true);
});

test('a changed module behind the door is the candidate\'s doing, and the budget alone refuses it [C7]', async t => {
  const { job } = runnerLayout(t);
  writeFileSync(join(job, LOOP), SLOW.replace('4e8', '5e8'));
  assert.equal(await doorMatchesMain(job, DOOR, importSpecifiers), false);
  const [problem, ...rest] = await lightDoorProblems(job);
  assert.deepEqual(rest, []);
  assert.match(problem.text, /light door cold load \d+ ms exceeds its 100 ms budget;/u);
});

test('edges.js prints every refusal on stderr, never a bare exit 1 [C7]', t => {
  const { root, write: put } = privateFixtureFiles('edges-main-refuse-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put('packages/codemap/data/plan/cells.json', JSON.stringify({ cells: [{ file: 'packages/codemap/data/plan/cells/kernel.json' }], allowedEdges: ['kernel->nowhere'] }));
  put('packages/codemap/data/plan/cells/kernel.json', JSON.stringify({ name: 'kernel' }));
  put('packages/kernel/index.js', 'export const k = 1;\n');
  const written = { out: '', err: '' }, write = { out: process.stdout.write, err: process.stderr.write }, exitCode = process.exitCode;
  process.stdout.write = chunk => { written.out += chunk; return true; };
  process.stderr.write = chunk => { written.err += chunk; return true; };
  let code;
  try { refuse(cellsEdgeProblems(root)); code = process.exitCode; }
  finally { process.stdout.write = write.out; process.stderr.write = write.err; process.exitCode = exitCode; }
  assert.equal(code, 1);
  assert.equal(written.out, '');
  assert.match(written.err, /packages\/codemap:1: allowedEdges entry "kernel->nowhere" is used by no import/u);
  refuse([]);
  assert.equal(process.exitCode, 0, 'no problems exit 0 and print nothing');
  process.exitCode = exitCode;
});
