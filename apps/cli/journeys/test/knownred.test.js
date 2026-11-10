/** @pullboard-test-loads apps/cli/src/io/commands/test.js */
/** A known red must not compare against main: "is it red" is enough, so pullboard test --compare-main starts no main run for it [C7]. */
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
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import {
  HOST,
  installSshStandIn,
} from '../../tests/fixtures/runner/ssh.js';

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
  writeFileSync(join(box.repo, 'test/red.test.js'),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('red case', () => assert.fail('deliberate'));\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: one red file');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return box;
}

/** File an open Main red item for a file, the way the landing files one. */
function fileMainRed(box, file) {
  fileFixtureItem(box, box.repo, { lane: 'core', title: `Main red: ${file}`, criterion: `${file} passes on main.`, check: `node --test ${file}`,
    brief: `Files: ${file}\nTest: the file passes` });
}

/** Run the red file with --compare-main and parse its result. */
function compare(box) {
  const json = box.run(box.web, 'test', 'test/red.test.js', '--compare-main', '--json');
  assert.equal(json.code, 1, json.err);
  return JSON.parse(json.out);
}

test('clause 1: a file that is the subject of an open Main red item starts no main run [C7]', { timeout: 240_000 }, () => { // budget: hang ceiling for one stand-in runner run.
  const box = redProject();
  fileMainRed(box, 'test/red.test.js');
  const result = compare(box);
  assert.equal(result.main, null, 'no main run started');
  assert.deepEqual(result.known, []);
  assert.match(result.mainSkipped, /known red.*Main red/u);
  const text = box.run(box.web, 'test', 'test/red.test.js', '--compare-main');
  assert.equal(text.code, 1);
  assert.match(text.err, /main comparison skipped: known red/u);
  assert.doesNotMatch(text.err, /waiting on the main comparison/u);
  assert.doesNotMatch(text.out, /also fails on main/u);
});

test('clause 1: an open Main red item under the file\'s pre-move name counts too [C7]', { timeout: 240_000 }, () => { // budget: hang ceiling for one stand-in runner run.
  const box = redProject();
  mkdirSync(join(box.repo, 'packages/codemap/data/plan/path-map'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/codemap/data/plan/path-map/old.json'), JSON.stringify({ 'test/old-red.test.js': 'test/red.test.js' }));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: path map');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  fileMainRed(box, 'test/old-red.test.js');
  const result = compare(box);
  assert.equal(result.main, null, 'no main run started');
  assert.match(result.mainSkipped, /known red/u);
});

test('clause 1: a recorded red main result is reused, so the second --compare-main starts no main run [C7]', { timeout: 480_000 }, () => { // budget: hang ceiling for two stand-in runner runs plus one main run.
  const box = redProject();
  const first = compare(box);
  assert.ok(first.main, 'with no item and no record, main is compared once');
  assert.equal(first.known[0]?.result, 'red');
  const second = compare(box);
  assert.equal(second.main, null, 'the recorded red is not run on main again');
  assert.match(second.mainSkipped, /known red.*recorded/u);
});
