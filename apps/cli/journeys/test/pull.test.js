/** Under gate.runnerDispatch pull, `pullboard test --wait` is one runner job: a real runner serve process fetches the seat's commit from the trunk remote and runs the files, and nothing is packed or sent over ssh from the seat's machine [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';

const REPO = resolve(import.meta.dirname, '../../../..');
const BIN = resolve(import.meta.dirname, '../../pullboard.js');

/** Accepted main's TAP reader, the one the gate entry imports to name failing cases. */
const LIGHT = `export { tapFailures } from ${JSON.stringify(pathToFileURL(join(REPO, 'packages/gate/light.js')).href)};\n`;

/** A test file that notes the folder it ran in, so the run is seen on the runner and not on the seat's machine. */
const PASS = `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
test('passes where it runs', () => { appendFileSync(process.env.PULLBOARD_FIXTURE_STEPS, JSON.stringify({ step: 'test', cwd: process.cwd() }) + '\\n'); });
`;
const MAIN_FAIL = `import assert from 'node:assert/strict';
import { test } from 'node:test';
test('breaks on main too', () => { assert.equal(1, 2); });
`;

/**
 * A pull project whose main names a focused test runner and carries one failing test, with a seat branch that adds a
 * passing test and a second failing case; the seat's PATH starts with an ssh that only records it was called.
 */
async function testProject(t) {
  const box = await pullProject(t, 1, { tooling: { 'packages/gate/light.js': LIGHT } });
  const config = join(box.repo, 'pullboard.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), affectedTests: 'node --test' }, null, 2) + '\n');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/fail.test.js'), MAIN_FAIL);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: focused runner and a main red [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  writeFileSync(join(box.web, 'web/pass.test.js'), PASS);
  writeFileSync(join(box.web, 'web/fail.test.js'), `${MAIN_FAIL}test('breaks only here', () => { assert.equal(3, 4); });\n`);
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): tests to run on a runner [G1]');
  const shims = join(box.runnerHome, 'shims'), marker = join(box.runnerHome, 'ssh-called');
  mkdirSync(shims, { recursive: true });
  writeFileSync(join(shims, 'ssh'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(marker)}\nexit 255\n`);
  chmodSync(join(shims, 'ssh'), 0o755);
  box.env.PATH = `${shims}:${box.env.PATH}`;
  const queue = await pullQueue(t, box);
  return { box, queue, marker };
}

/** Start `pullboard test --wait <args>` in the seat's checkout as its own process. */
function testInSeat(box, args) {
  return box.helpers.launch(box, box.web, process.execPath, [BIN, 'test', '--wait', ...args]);
}

test('clauses 1 and 2: pullboard test --wait offers one test job at the seat\'s commit, a real runner serve process fetches it from the trunk remote and runs the file, and the seat prints its green result with no ssh or packing [P7]', { timeout: 180_000 }, // budget: hang ceiling for a project, one test job and one runner process.
async t => {
  const { box, queue, marker } = await testProject(t);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const steps = join(box.runnerHome, 'steps.jsonl');
  const seat = testInSeat(box, ['web/pass.test.js']);
  const served = await serveOnce(box, queue.url, 'r-test', { PULLBOARD_FIXTURE_STEPS: steps });
  assert.equal(served.code, 0, served.output);
  const done = await seat.closed;
  assert.equal(done.code, 0, `${seat.stderrText}\n${seat.stdoutText}`);
  assert.match(seat.stderrText, /pullboard test: green on r-test in \d+s/u, 'the seat prints today\'s verdict line, naming the runner that ran it');
  assert.match(seat.stdoutText, /1 passed, 0 failed/u, 'the seat prints the run\'s summary');

  const [job] = jobsOf(queue.board.db, { kind: 'test' });
  assert.equal(job.candidate, commit, 'the job names the seat\'s commit');
  assert.equal(job.step, 'done');
  const { receipt, runner } = job.steps.find(step => step.name === 'receipt').payload;
  assert.equal(runner, 'r-test');
  assert.equal(receipt.gate.green, true, JSON.stringify(receipt.gate).slice(0, 4000));
  const ran = readFileSync(steps, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.step === 'test');
  assert.equal(ran.length, 1, 'the file ran once');
  assert.ok(ran[0].cwd.includes(join('r-test', 'work')), `the file ran in the runner's checkout, not the seat's: ${ran[0].cwd}`);
  assert.equal(existsSync(marker), false, 'the seat started no ssh process');
  assert.equal(box.git(box.repo, 'for-each-ref', 'refs/pullboard/test'), '', 'the pin is dropped once the receipt is in');
});

test('clause 1: a red run with --compare-main is compared with main by a second test job, naming the case main also fails and the one only the change fails [P7]', { timeout: 180_000 }, // budget: as clause 1, with a second job at main.
async t => {
  const { box, queue, marker } = await testProject(t);
  const seat = testInSeat(box, ['--compare-main', 'web/fail.test.js']);
  const first = await serveOnce(box, queue.url, 'r-candidate');
  assert.equal(first.code, 0, first.output);
  // The main job is offered only after the candidate's red receipt; a seat that ends first offered none.
  const second = await Promise.race([serveOnce(box, queue.url, 'r-main'), seat.closed.then(() => null)]);
  assert.ok(second, `the seat ended before offering a main job: ${seat.stderrText}\n${seat.stdoutText}`);
  assert.equal(second.code, 0, second.output);
  const done = await seat.closed;
  assert.equal(done.code, 1, `${seat.stderrText}\n${seat.stdoutText}`);
  assert.match(seat.stderrText, /pullboard test: red on r-candidate/u);
  assert.match(seat.stdoutText, /also fails on main at [0-9a-f]{40}: web\/fail\.test\.js :: breaks on main too/u);
  assert.match(seat.stdoutText, /fails only with your change: web\/fail\.test\.js :: breaks only here/u);
  const jobs = jobsOf(queue.board.db, { kind: 'test' });
  assert.deepEqual(jobs.map(job => job.candidate), [box.git(box.web, 'rev-parse', 'HEAD'), box.git(box.repo, 'rev-parse', 'main')], 'one job at the candidate, then one at main');
  assert.equal(existsSync(marker), false, 'the seat started no ssh process');
});

test('clause 3: an uncommitted change is refused with the words the runner path prints today, and no test job is offered [P7]', { timeout: 120_000 }, // budget: hang ceiling for a project and one refused command.
async t => {
  const { box, queue } = await testProject(t);
  writeFileSync(join(box.web, 'web/pass.test.js'), `${PASS}// an uncommitted edit\n`);
  const refused = await box.runLocal(box.web, 'test', '--wait', 'web/pass.test.js');
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /TEST_UNCOMMITTED/u);
  assert.match(refused.err, /pullboard test: uncommitted changes in web\/pass\.test\.js; the runner tests the committed source at [0-9a-f]{10}, so these edits are not under test; commit them and run again/u);
  assert.deepEqual(jobsOf(queue.board.db, { kind: 'test' }), []);
});
