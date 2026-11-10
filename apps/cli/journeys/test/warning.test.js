/** @pullboard-test-loads apps/cli/src/io/commands/test.js */
/** pullboard test says plainly when the checkout has uncommitted changes the runner will not test [C7]. */
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
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  HOST,
  installSshStandIn,
} from '../../tests/fixtures/runner/ssh.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A project with one committed green test file and a stand-in runner. */
function greenProject() {
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
  writeFileSync(join(box.repo, 'test/green.test.js'),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('green case', () => assert.ok(true));\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: one green file');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return box;
}

test('clause 1: pullboard test from a checkout with an uncommitted tracked edit names the file and the committed commit before admission [C7]', { timeout: 240_000 }, () => { // budget: hang ceiling for one stand-in runner run.
  const box = greenProject();
  const head = box.git(box.web, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(box.web, 'test/green.test.js'),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('green case', () => assert.ok(true));\n// uncommitted edit\n");
  const ran = box.run(box.web, 'test', 'test/green.test.js');
  assert.equal(ran.code, 0, ran.err);
  const lines = ran.err.split('\n').filter(line => /uncommitted changes/u.test(line));
  assert.equal(lines.length, 1, 'one line names the uncommitted changes');
  assert.match(lines[0], /test\/green\.test\.js/u, 'the line names the edited file');
  assert.ok(lines[0].includes(head.slice(0, 10)), 'the line names the committed commit the runner tests');
  assert.match(lines[0], /not under test/u);
  assert.ok(ran.err.indexOf(lines[0]) < ran.err.indexOf('admitted on'), 'the line comes before admission');
});

test('clause 2: pullboard test from a clean checkout prints no uncommitted-changes line [C7]', { timeout: 240_000 }, () => { // budget: hang ceiling for one stand-in runner run.
  const box = greenProject();
  const ran = box.run(box.web, 'test', 'test/green.test.js');
  assert.equal(ran.code, 0, ran.err);
  assert.doesNotMatch(ran.err, /uncommitted changes/u);
});
