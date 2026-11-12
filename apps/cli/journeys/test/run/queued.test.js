/** @pullboard-test-loads apps/cli/src/io/commands/test.js */
/** @pullboard-test-loads apps/cli/src/io/commands/next.js */
/** @pullboard-test-loads packages/jobs/src/io/test-run-queue.js */
/** A seat's pullboard test queues on the board and returns at once; next hands the result back; --wait blocks [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import {
  HOST,
  installSshStandIn,
} from '../../../tests/fixtures/runner/ssh.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { MACHINE_CONTEXT_ENV } from '../../../../../packages/drive/index.js';
import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';

const BIN = resolve(import.meta.dirname, '../../../pullboard.js');

const e2e = createE2eHelpers();
after(e2e.cleanup);

const PASSES = "import { test } from 'node:test';\ntest('passes', () => {});\n";
const FAILS = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('red case', () => assert.fail('deliberate'));\n";

/** A project with one stand-in runner and a green and a red test file on main, merged into the web seat. */
function runnerProject() {
  const box = e2e.project('true');
  const bin = join(box.dir, 'runner-bin');
  const worker = join(box.dir, 'runner-worker');
  const home = join(box.dir, 'runner-home');
  const requests = join(box.dir, 'runner-requests.jsonl');
  for (const folder of [bin, worker, home, join(home, '.pullboard')]) mkdirSync(folder, { recursive: true });
  box.env.PATH = `${bin}:${box.env.PATH}`;
  installSshStandIn({ bin, worker, home, machineHome: join(home, '.pullboard'), requests });
  assert.equal(box.run(box.repo, 'runner', 'add', HOST, '--slots', '2', '--browser', '1').code, 0);
  for (const [key, value] of [['gate.runnersFirst', 'on'], ['browserSlots', '0'], ['gateSlots', '0']]) {
    const set = box.run(box.repo, 'settings', key, value);
    assert.equal(set.code, 0, `${key} ${value}: ${set.err}`);
  }
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, affectedTests: 'node --test --test-reporter=tap --test-timeout=3000' }, null, 2));
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test/green.test.js'), PASSES);
  writeFileSync(join(box.repo, 'test/red.test.js'), FAILS);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: one green and one red file');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return box;
}

/**
 * Run one CLI command as the seat's agent session at its own prompt, timing it: the agent-shell marker set, and none
 * of the machine-work variables the test runner itself puts in this process's environment.
 */
function asSeat(box, ...args) {
  return seatRun(box, {}, ...args);
}

/**
 * Run as the seat with only `extra` of the machine variables set; every other one the test runner set is removed.
 * With `marker: false` no agent-shell marker is set either, as for a seat launched over ssh.
 */
function seatRun(box, extra, ...args) {
  return markedRun(box, extra, true, ...args);
}

/** Run as the seat with `extra` set, with or without the agent-shell marker, and time it. */
function markedRun(box, extra, marker, ...args) {
  const saved = Object.fromEntries([...MACHINE_CONTEXT_ENV, 'PULLBOARD_CLI_PID', 'PULLBOARD_TEST_WAIT', ...AGENT_SHELL_MARKERS].map(name => [name, box.env[name]]));
  for (const name of Object.keys(saved)) delete box.env[name];
  Object.assign(box.env, extra);
  if (marker) box.env.CLAUDECODE = '1';
  try {
    const started = performance.now();
    const ran = box.run(box.web, ...args);
    return { ...ran, ms: performance.now() - started };
  } finally {
    for (const name of [...Object.keys(saved), ...Object.keys(extra)]) delete box.env[name];
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) box.env[name] = value;
  }
}

/** Run one CLI command as the seat's agent session with extra machine variables set, as machine work starts it. */
function asSeatInside(box, extra, ...args) {
  return seatRun(box, extra, ...args);
}

test('a seat\'s pullboard test returns in under 1 s with a run id, and next hands back the red result [C7]', { timeout: 240_000 }, () => { // budget: hang ceiling for one stand-in runner run.
  const box = runnerProject();
  const queued = asSeat(box, 'test', 'test/red.test.js', '--json');
  assert.equal(queued.code, 0, queued.err);
  assert.ok(queued.ms < 1000, `the seat's call returns at once (${Math.round(queued.ms)} ms)`); // budget: the queue answer, never the run.
  const ack = JSON.parse(queued.out);
  assert.equal(ack.queued, true);
  assert.match(ack.run, /^[0-9a-f-]{36}$/u, 'the answer carries the run id');
  assert.ok(['queued', 'running'].includes(ack.status));

  const status = asSeat(box, 'test', '--status', ack.run);
  assert.match(status.out, new RegExp(`test run ${ack.run} (queued|running|red)`, 'u'), 'status prints the run once');

  const next = asSeat(box, 'next');
  assert.equal(next.code, 0, next.err);
  assert.match(next.out, new RegExp(`test run ${ack.run} red on ${HOST}`, 'u'), 'next hands back the outcome and where it ran');
  assert.match(next.out, /failing: .*red case/u, 'next names the failing test');
  assert.match(next.out, /log: \S+/u, 'next names the log');
  assert.doesNotMatch(asSeat(box, 'next').out, new RegExp(ack.run, 'u'), 'a run comes back once');
  const after = asSeat(box, 'test', '--status', ack.run, '--json');
  assert.equal(JSON.parse(after.out).status, 'red');
});

test('a seat\'s green run comes back through next --take before its next item [C7]', { timeout: 240_000 }, () => { // budget: hang ceiling for one stand-in runner run.
  const box = runnerProject();
  const queued = asSeat(box, 'test', 'test/green.test.js');
  assert.equal(queued.code, 0, queued.err);
  const id = /queued test run ([0-9a-f-]{36})/u.exec(queued.out)?.[1];
  assert.ok(id, `one line names the run: ${queued.out}`);
  assert.match(queued.out, /pullboard next/u, 'the line says the result comes through next');
  assert.doesNotMatch(queued.out + queued.err, /\b(wait|sleep|poll)\b/iu, 'nothing tells the seat to wait');
  const next = asSeat(box, 'next');
  assert.match(next.out, new RegExp(`test run ${id} green on ${HOST}`, 'u'));
});

test('--wait still blocks for a non-seat caller and prints the result itself [C7]', { timeout: 240_000 }, () => { // budget: hang ceiling for one stand-in runner run.
  const box = runnerProject();
  const ran = box.run(box.web, 'test', 'test/red.test.js', '--wait', '--json');
  assert.equal(ran.code, 1, 'the blocking run exits red');
  const result = JSON.parse(ran.out);
  assert.equal(result.runner, HOST, 'the files ran before the command returned');
  assert.equal(result.green, false);
  const plain = box.run(box.web, 'test', 'test/green.test.js');
  assert.equal(plain.code, 0, 'outside an agent session the call blocks as it always did');
  assert.match(plain.err, new RegExp(`green on ${HOST}`, 'u'));
});

test('an item check that runs pullboard test on a red file fails, never a queued pass [C7]', { timeout: 240_000 }, () => { // budget: hang ceiling for the check and its nested runner run.
  const box = runnerProject();
  // The check's file sits in the web lane, so the web seat may build the item whose check names it.
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web', 'red.test.js'), FAILS);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: a red file in the web lane');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Red check', '--specs', 'G1', '--criterion', 'the red file fails its check', '--brief', 'Files: web/page.js. Change: none. Test case: red case.', '--check', `"${process.execPath}" "${BIN}" test web/red.test.js`);
  assert.equal(added.code, 0, `add: ${added.out}${added.err}`);
  const claimed = box.run(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, `claim: ${claimed.out}${claimed.err}`);
  const checked = asSeat(box, 'check', '--yes');
  assert.notEqual(checked.code, 0, `the red check is red: ${checked.out}${checked.err}`);
  assert.doesNotMatch(checked.out + checked.err, /queued test run/u, 'the check never got the queued answer');
});

test('a seat call under a live outer pullboard command or machine variables blocks and returns red [C7]', { timeout: 240_000 }, () => { // budget: hang ceiling for two stand-in runner runs.
  const box = runnerProject();
  // This test process stands in for the live gate or check that started the call.
  const nested = asSeatInside(box, { PULLBOARD_CLI_PID: String(process.pid) }, 'test', 'test/red.test.js');
  assert.equal(nested.code, 1, `under a live pullboard command the run blocks and exits red: ${nested.out}${nested.err}`);
  assert.doesNotMatch(nested.out, /queued test run/u);
  const runnerJob = asSeatInside(box, { GIT_NO_REPLACE_OBJECTS: '1' }, 'test', 'test/red.test.js');
  assert.equal(runnerJob.code, 1, 'in the check runner\'s clean git environment the run blocks and exits red');
  assert.doesNotMatch(runnerJob.out, /queued test run/u);
});

/** Add one web-lane item and claim it from the web seat, so the seat holds a live build claim. */
function claimOne(box) {
  const added = fixtureAdd(box.run, box.repo, 'web', 'Held claim', '--specs', 'G1', '--criterion', 'the seat holds a claim', '--brief', 'Files: web/page.js. Change: none. Test case: none.', '--check', 'true');
  assert.equal(added.code, 0, `add: ${added.out}${added.err}`);
  const claimed = box.run(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, `claim: ${claimed.out}${claimed.err}`);
}

test('clause 1: a seat holding a claim queues test --wait at once with no agent marker, printing the run id and its status command [P7]', { timeout: 240_000 }, () => { // budget: hang ceiling for one stand-in runner run.
  const box = runnerProject();
  claimOne(box);
  const queued = markedRun(box, { PULLBOARD_TEST_WAIT: '1' }, false, 'test', 'test/red.test.js', '--wait');
  assert.equal(queued.code, 0, `${queued.out}${queued.err}`);
  assert.ok(queued.ms < 1000, `the claimed seat's call returns at once (${Math.round(queued.ms)} ms)`); // budget: the queue answer, never the run.
  const id = /queued test run ([0-9a-f-]{36})/u.exec(queued.out)?.[1];
  assert.ok(id, `the reply names the run: ${queued.out}`);
  assert.match(queued.out, /pullboard next brings the result/u, 'the reply says the result comes through next');
  assert.match(queued.out, new RegExp(`pullboard test --status ${id}`, 'u'), 'the reply prints the command that shows the result');
  const status = markedRun(box, {}, false, 'test', '--status', id);
  assert.match(status.out, new RegExp(`test run ${id} (queued|running|red)`, 'u'), 'the printed status command reads the run');
});

test('clause 2: a seat holding no claim keeps the blocking --wait inside an agent shell [P7]', { timeout: 240_000 }, () => { // budget: hang ceiling for one stand-in runner run.
  const box = runnerProject();
  const ran = asSeat(box, 'test', 'test/red.test.js', '--wait', '--json');
  assert.equal(ran.code, 1, `the blocking run exits red: ${ran.out}${ran.err}`);
  assert.doesNotMatch(ran.out, /queued test run/u);
  assert.equal(JSON.parse(ran.out).runner, HOST, 'the files ran before the command returned');
});
