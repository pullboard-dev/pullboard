/** @pullboard-test-loads apps/cli/src/io/commands/test.js */
/** @pullboard-test-loads packages/drive/src/io/queue.js */
/** A seat holding a claim never blocks on pullboard test, whatever --wait or its shell says; no claim keeps --wait [P7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
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

const e2e = createE2eHelpers();
after(e2e.cleanup);

const FAILS = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('red case', () => assert.fail('deliberate'));\n";

/** A project with one stand-in runner and a red test file on main, merged into the web seat. */
async function runnerProject() {
  const box = e2e.project('true');
  const bin = join(box.dir, 'runner-bin');
  const worker = join(box.dir, 'runner-worker');
  const home = join(box.dir, 'runner-home');
  for (const folder of [bin, worker, home, join(home, '.pullboard')]) mkdirSync(folder, { recursive: true });
  box.env.PATH = `${bin}:${box.env.PATH}`;
  installSshStandIn({ bin, worker, home, machineHome: join(home, '.pullboard'), requests: join(box.dir, 'runner-requests.jsonl') });
  assert.equal((await box.inProcess(box.repo, 'runner', 'add', HOST, '--slots', '2', '--browser', '1')).code, 0);
  for (const [key, value] of [['gate.runnersFirst', 'on'], ['browserSlots', '0'], ['gateSlots', '0']]) {
    const set = await box.inProcess(box.repo, 'settings', key, value);
    assert.equal(set.code, 0, `${key} ${value}: ${set.err}`);
  }
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, affectedTests: 'node --test --test-reporter=tap --test-timeout=3000' }, null, 2));
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test/red.test.js'), FAILS);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: one red file');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return box;
}

/**
 * Run one CLI command from the web seat with only `extra` set: every machine-work variable, agent-shell marker and
 * PULLBOARD_TEST_WAIT the test runner put in this environment is removed, and CLAUDECODE is set only with `marker`.
 */
async function seatRun(box, extra, marker, ...args) {
  const names = [...MACHINE_CONTEXT_ENV, 'PULLBOARD_CLI_PID', 'PULLBOARD_TEST_WAIT', ...AGENT_SHELL_MARKERS];
  const saved = Object.fromEntries(names.map(name => [name, box.env[name]]));
  for (const name of names) delete box.env[name];
  Object.assign(box.env, extra, marker ? { CLAUDECODE: '1' } : {});
  try {
    const started = performance.now();
    const ran = await box.inProcess(box.web, ...args);
    return { ...ran, ms: performance.now() - started };
  } finally {
    for (const name of [...names, ...Object.keys(extra)]) delete box.env[name];
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) box.env[name] = value;
  }
}

test('clause 1: a seat holding a claim queues test --wait at once with no agent marker, printing the run id and its status command [P7]', { timeout: 240_000 }, async () => { // budget: hang ceiling for one stand-in runner run.
  const box = await runnerProject();
  const added = await fixtureAdd(box.inProcess, box.repo, 'web', 'Held claim', '--specs', 'G1', '--criterion', 'the seat holds a claim', '--brief', 'Files: web/page.js. Change: none. Test case: none.', '--check', 'true');
  assert.equal(added.code, 0, `add: ${added.out}${added.err}`);
  const claimed = await box.inProcess(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, `claim: ${claimed.out}${claimed.err}`);
  const queued = await seatRun(box, { PULLBOARD_TEST_WAIT: '1' }, false, 'test', 'test/red.test.js', '--wait');
  assert.equal(queued.code, 0, `${queued.out}${queued.err}`);
  assert.ok(queued.ms < 1000, `the claimed seat's call returns at once (${Math.round(queued.ms)} ms)`); // budget: the queue answer, never the run.
  const id = /queued test run ([0-9a-f-]{36})/u.exec(queued.out)?.[1];
  assert.ok(id, `the reply names the run: ${queued.out}`);
  assert.match(queued.out, /pullboard next brings the result/u, 'the reply says the result comes through next');
  assert.match(queued.out, new RegExp(`pullboard test --status ${id}`, 'u'), 'the reply prints the command that shows the result');
  const status = await seatRun(box, {}, false, 'test', '--status', id);
  assert.match(status.out, new RegExp(`test run ${id} (queued|running|red)`, 'u'), 'the printed status command reads the run');
});

test('clause 2: a seat holding no claim keeps the blocking --wait inside an agent shell [P7]', { timeout: 240_000 }, async () => { // budget: hang ceiling for one stand-in runner run.
  const box = await runnerProject();
  const ran = await seatRun(box, {}, true, 'test', 'test/red.test.js', '--wait', '--json');
  assert.equal(ran.code, 1, `the blocking run exits red: ${ran.out}${ran.err}`);
  assert.doesNotMatch(ran.out, /queued test run/u);
  assert.equal(JSON.parse(ran.out).runner, HOST, `the files ran before the command returned: ${ran.out}${ran.err}`);
});
