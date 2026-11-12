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
import { knownRedCheck } from '../../src/io/test/known.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import {
  HOST,
  installSshStandIn,
} from '../../tests/fixtures/runner/ssh.js';

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

/** File an open Main red item titled for a file, the way the landing files one; its bar names `bar`, which must exist on main. */
async function fileMainRed(box, file, bar = file) {
  await fileFixtureItem(box, box.repo, { lane: 'web', title: `Main red: ${file} 1 failing case on main abc123`, criterion: `${bar} passes on main.`, check: `node --test ${bar}`,
    brief: `Files: web/repair.js\nChange: repair the red file\nTest: ${bar} passes`, args: ['--specs', 'G1'], run: box.runLocal });
}

/** Run the red file with --compare-main and parse its result. */
async function compare(box) {
  const json = await box.runLocal(box.web, 'test', 'test/red.test.js', '--compare-main', '--json');
  assert.equal(json.code, 1, json.err);
  return JSON.parse(json.out);
}

test('clause 1: a file that is the subject of an open Main red item starts no main run [C7]', { timeout: 240_000 }, async () => { // budget: hang ceiling for one stand-in runner run.
  const box = await redProject();
  await fileMainRed(box, 'test/red.test.js');
  const result = await compare(box);
  assert.equal(result.main, null, 'no main run started');
  assert.deepEqual(result.known, []);
  assert.match(result.mainSkipped, /known red.*Main red/u);
  const text = await box.runLocal(box.web, 'test', 'test/red.test.js', '--compare-main');
  assert.equal(text.code, 1);
  assert.match(text.err, /main comparison skipped: known red/u);
  assert.doesNotMatch(text.err, /waiting on the main comparison/u);
  assert.doesNotMatch(text.out, /also fails on main/u);
});

test('clause 1: an open Main red item under the file\'s pre-move name counts too [C7]', { timeout: 240_000 }, async () => { // budget: hang ceiling for one stand-in runner run.
  const box = await redProject();
  mkdirSync(join(box.repo, 'packages/codemap/data/plan/path-map'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/codemap/data/plan/path-map/old.json'), JSON.stringify({ 'test/old-red.test.js': 'test/red.test.js' }));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: path map');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  // The title keeps the pre-move name; the bar names the file where it lives on main now, as add requires.
  await fileMainRed(box, 'test/old-red.test.js', 'test/red.test.js');
  const result = await compare(box);
  assert.equal(result.main, null, 'no main run started');
  assert.match(result.mainSkipped, /known red/u);
});


test('a candidate cannot invent a main-red alias with its own path map [C7]', async () => {
  const box = await redProject();
  const directory = join(box.web, 'packages/codemap/data/plan/path-map');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'invented.json'), JSON.stringify({ 'test/other.test.js': 'test/red.test.js' }));
  const known = knownRedCheck(box.web, () => [{ item_id: 7, item_status: 'open', item_title: 'Main red: test/other.test.js' }]);
  assert.equal(known('test/red.test.js'), null, 'only the accepted main map can establish a moved identity');
});

test('an unsigned generic red cache cannot suppress an executor-bound comparison [C7]', { timeout: 240_000 }, async () => { // budget: candidate and main runner runs.
  const box = await redProject();
  const main = String(box.git(box.repo, 'rev-parse', 'HEAD')).trim();
  const folder = join(box.repo, '.git/pullboard');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const failure = { file: 'test/red.test.js', name: 'red case', signature: 'a'.repeat(64) };
  writeFileSync(join(folder, 'main-red.json'), JSON.stringify({ version: 2, entries: { [main]: { 'test/red.test.js': { result: 'red', failures: [failure], signatureVersion: 4 } } } }), { mode: 0o600 });
  const result = await compare(box);
  assert.equal(result.main, main, 'unbound generic cache must not suppress the main comparison');
  assert.equal(result.known[0].result, 'red');
});

test('the direct test API without a known-red callback still requests ordinary main comparison [C7]', { timeout: 240_000 }, async () => { // budget: one real stand-in runner dispatch.
  const box = await redProject();
  const gate = new URL('../../../../packages/gate/index.js', import.meta.url).href;
  const landing = new URL('../../../../packages/landing/index.js', import.meta.url).href;
  const driver = `import { readFileSync } from 'node:fs';
import { runTestFiles } from ${JSON.stringify(gate)};
import { withMainCheckout, failureSignatures } from ${JSON.stringify(landing)};
${executionServicesSource(gate)}
let called = false;
const result = await runTestFiles(process.cwd(), JSON.parse(readFileSync('pullboard.json')), ['test/red.test.js'], { compareMain: true, executionServices, withMainCheckout, failureSignatures, compareMainFailures: async () => { called = true; return { main: null, files: [], unavailable: 'fixture deliberately supplies no main proof' }; } });
console.log(JSON.stringify({ called, green: result.green, unavailable: result.mainUnavailable }));`;
  // Process-level case: the driver is a bare node child that imports the gate API, not a CLI call.
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', driver], { cwd: box.web, env: box.env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.context);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.deepEqual(result, { called: true, green: false, unavailable: 'fixture deliberately supplies no main proof' });
});
