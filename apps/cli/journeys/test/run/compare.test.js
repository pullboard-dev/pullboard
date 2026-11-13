/** @pullboard-test-loads apps/cli/src/io/commands/test.js */
/** A one-file pullboard test is the builder's own run; main's comparison runs only when asked [C7]. */
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

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A project whose one test file is red on a stand-in runner, committed so main has the same red file. */
async function redProject() {
  const box = e2e.project('true');
  const bin = join(box.dir, 'runner-bin');
  const worker = join(box.dir, 'runner-worker');
  const home = join(box.dir, 'runner-home');
  const requests = join(box.dir, 'runner-requests.jsonl');
  for (const folder of [bin, worker, home, join(home, '.pullboard')]) mkdirSync(folder, { recursive: true });
  box.env.PATH = `${bin}:${box.env.PATH}`;
  installSshStandIn({ bin, worker, home, machineHome: join(home, '.pullboard'), requests });
  assert.equal((await box.runLocal(box.repo, 'runner', 'add', HOST, '--slots', '2', '--browser', '1')).code, 0);
  for (const [key, value] of [['gate.runnersFirst', 'on'], ['browserSlots', '0'], ['gateSlots', '0']]) {
    const set = await box.runLocal(box.repo, 'settings', key, value);
    assert.equal(set.code, 0, `${key} ${value}: ${set.err}`);
  }
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, affectedTests: 'node --test --test-reporter=tap --test-timeout=3000' }, null, 2));
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test/red.test.js'),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('red case', () => assert.fail('deliberate'));\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: one red file');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return box;
}

test('clause 1: pullboard test <one file> reports its red cases without re-running the file on main [C7]', { timeout: 240_000 }, async () => { // budget: hang ceiling for one stand-in runner run.
  const box = await redProject();
  const json = await box.runLocal(box.web, 'test', 'test/red.test.js', '--json');
  assert.equal(json.code, 1);
  const result = JSON.parse(json.out);
  assert.equal(result.main, null, 'no main comparison ran');
  assert.deepEqual(result.known, []);
  assert.match(result.mainSkipped, /--compare-main/u);
  const text = await box.runLocal(box.web, 'test', 'test/red.test.js');
  assert.equal(text.code, 1);
  assert.match(text.err, /main comparison skipped/u);
  assert.doesNotMatch(text.out, /also fails on main/u, 'the red file is not re-run on main');
});

test('clause 2: pullboard test <file> --compare-main still runs the main comparison and prints that it is waiting on it [C7]', { timeout: 240_000 }, async () => { // budget: hang ceiling for one run plus its main comparison.
  const box = await redProject();
  const ran = await box.runLocal(box.web, 'test', 'test/red.test.js', '--compare-main');
  assert.equal(ran.code, 1);
  assert.match(ran.err, /waiting on the main comparison/u);
  assert.match(ran.out, /also fails on main at [a-f0-9]+: test\/red\.test\.js/u, 'main was compared');
  assert.doesNotMatch(ran.err, /main comparison skipped/u);
});
