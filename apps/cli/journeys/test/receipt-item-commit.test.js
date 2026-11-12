/** @pullboard-test-loads apps/cli/src/io/commands/test.js */
/** @pullboard-test-loads packages/drive/src/io/queue.js */
/** @pullboard-test-loads packages/store/src/io/receipts.js */
/** A green pullboard test run records a proof-run naming its item and commit, and show lists it [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
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

const PASSES = "import { test } from 'node:test';\ntest('passes', () => {});\n";

/** A project with one stand-in runner and a green test file on main, merged into the web seat. */
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
  writeFileSync(join(box.repo, 'test/ok.test.js'), PASSES);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: one green file');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return box;
}

/** Run one CLI command from the web seat with every machine-work variable and agent-shell marker removed. */
async function seatRun(box, ...args) {
  const names = [...MACHINE_CONTEXT_ENV, 'PULLBOARD_CLI_PID', 'PULLBOARD_TEST_WAIT', ...AGENT_SHELL_MARKERS];
  const saved = Object.fromEntries(names.map(name => [name, box.env[name]]));
  for (const name of names) delete box.env[name];
  try { return await box.inProcess(box.web, ...args); } finally {
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) box.env[name] = value;
  }
}

test('clause 1 and 2: a green run with --item N records a proof-run naming N and the head sha, and show N lists it [C7]', { timeout: 240_000 }, async () => { // budget: hang ceiling for one stand-in runner run.
  const box = await runnerProject();
  for (const title of ['First claim', 'Second claim']) {
    const added = await fixtureAdd(box.inProcess, box.repo, 'web', title, '--specs', 'G1', '--criterion', 'the seat holds a claim', '--brief', 'Files: web/page.js. Change: none. Test case: none.', '--check', 'true');
    assert.equal(added.code, 0, `add: ${added.out}${added.err}`);
  }
  for (const id of ['1', '2']) {
    const claimed = await box.inProcess(box.web, 'claim', id);
    assert.equal(claimed.code, 0, `claim ${id}: ${claimed.out}${claimed.err}`);
  }
  const head = box.git(box.web, 'rev-parse', 'HEAD').trim();
  const queued = await seatRun(box, 'test', 'test/ok.test.js', '--item', '2');
  assert.equal(queued.code, 0, `${queued.out}${queued.err}`);
  const id = /queued test run ([0-9a-f-]{36})/u.exec(queued.out)?.[1];
  assert.ok(id, `the reply names the run: ${queued.out}`);
  const next = await seatRun(box, 'next');
  assert.match(next.out, new RegExp(`test run ${id} green on ${HOST}`, 'u'), `next hands back the green run: ${next.out}${next.err}`);
  const shown = await box.inProcess(box.web, 'show', '2');
  assert.match(shown.out, /receipt [0-9a-f-]{36}: check, item #2/u, `show 2 lists the receipt: ${shown.out}`);
  assert.match(shown.out, new RegExp(`commit ${head}`, 'u'), 'the receipt names the head sha');
  const other = await box.inProcess(box.web, 'show', '1');
  assert.doesNotMatch(other.out, /receipt [0-9a-f-]{36}: check/u, 'the claim --item did not name gets no receipt');
});
