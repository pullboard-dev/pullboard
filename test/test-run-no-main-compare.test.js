/** @pullboard-test-loads apps/cli/src/shell/commands/test.js */
/** A one-file pullboard test is the builder's own run; main's comparison runs only when asked [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { HOST, installSshStandIn } from './runner-ssh-fixture.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A project whose one test file is red on a stand-in runner, committed so main has the same red file. */
function redProject() {
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
  writeFileSync(join(box.repo, 'test', 'red.test.js'),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('red case', () => assert.fail('deliberate'));\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: one red file');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return box;
}

test('clause 1: pullboard test <one file> reports its red cases without re-running the file on main [C7]', { timeout: 120_000 }, () => { // budget: hang ceiling for one real local run.
  const box = redProject();
  const ran = box.run(box.web, 'test', 'test/red.test.js', '--json');
  assert.equal(ran.code, 1);
  const result = JSON.parse(ran.out);
  assert.equal(result.main, null, 'no main comparison ran');
  assert.deepEqual(result.known, []);
  assert.match(result.mainSkipped, /--compare-main/u);
  assert.match(ran.err, /main comparison skipped/u);
});

test('clause 2: pullboard test <file> --compare-main still runs the main comparison and prints that it is waiting on it [C7]', { timeout: 180_000 }, () => { // budget: hang ceiling for one run plus its main comparison.
  const box = redProject();
  const ran = box.run(box.web, 'test', 'test/red.test.js', '--compare-main', '--json');
  assert.equal(ran.code, 1);
  const result = JSON.parse(ran.out);
  assert.ok(result.main, 'main was compared');
  assert.equal(result.mainSkipped, undefined);
  assert.match(ran.err, /waiting on the main comparison/u);
});
