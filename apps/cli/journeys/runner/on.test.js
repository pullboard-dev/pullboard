/** @pullboard-test-loads packages/gate/index.js */
/** pullboard test from an item folder runs one file on a free runner, prints its result lines, and returns promptly [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { localLoadStart } from '../../../../packages/gate/src/io/test/run.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  HOST,
  installSshStandIn,
} from '../../tests/fixtures/runner/ssh.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const MIXED = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n"
  + "test('keeps passing', () => {});\ntest('breaks on purpose', () => assert.equal(1, 2));\n";
const SLEEP_MS = 3000;
const TIMED = `import { test } from 'node:test';\nimport { setTimeout as pause } from 'node:timers/promises';\ntest('takes a known time', () => pause(${SLEEP_MS}));\n`;

/** One project with a single free stand-in runner and no local slot; the stand-in shares this machine's load, so load-aware dispatch is off. */
async function runnerProject() {
  const box = e2e.project('true');
  const bin = join(box.dir, 'runner-bin');
  const worker = join(box.dir, 'runner-worker');
  const home = join(box.dir, 'runner-home');
  const requests = join(box.dir, 'runner-requests.jsonl');
  for (const folder of [bin, worker, home, join(home, '.pullboard')]) mkdirSync(folder, { recursive: true });
  box.env.PATH = `${bin}:${box.env.PATH}`;
  installSshStandIn({ bin, worker, home, machineHome: join(home, '.pullboard'), requests });
  assert.equal((await box.runLocal(box.repo, 'runner', 'add', HOST, '--slots', '2', '--browser', '1')).code, 0);
  for (const [key, value] of [['gate.runnersFirst', 'on'], ['gate.loadAwareDispatch', 'off'], ['browserSlots', '0'], ['gateSlots', '0']]) {
    const set = await box.runLocal(box.repo, 'settings', key, value);
    assert.equal(set.code, 0, `${key} ${value}: ${set.err}`);
  }
  const configFile = join(box.repo, 'pullboard.json'), config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, affectedTests: 'node --test --test-reporter=tap' }, null, 2));
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test/timed.test.js'), TIMED);
  writeFileSync(join(box.repo, 'test/mixed.test.js'), MIXED);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: focused runner, a timed file and a failing case');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return { box, requests };
}

test('clause 1: pullboard test runs the folder commit on a free runner and prints pass/fail and failing cases [C7]', { timeout: 240_000 }, async () => { // budget: hang ceiling for a stand-in runner run plus its main comparison; not a speed target.
  const { box } = await runnerProject();
  const head = box.git(box.web, 'rev-parse', 'HEAD').trim();
  const ran = await box.runLocal(box.web, 'test', 'test/mixed.test.js');
  assert.equal(ran.code, 1, `a failing case makes the run red: ${ran.err}`);
  assert.match(ran.err, new RegExp(`red on ${HOST}`, 'u'), 'it ran on the free runner');
  assert.match(ran.out, /^1 passed, 1 failed, 0 skipped$/mu, 'the pass/fail line prints');
  assert.match(ran.out, /^test\/mixed\.test\.js: breaks on purpose: .+$/mu, 'the failing case prints with its error');
  assert.doesNotMatch(ran.out, /keeps passing: /u, 'a passing case is not listed as a failure');
  // The frame carrying the commit travels on stdin now, so the stand-in's request log no longer holds it; the runner's own repo keeps a candidate ref per received commit.
  const repos = join(box.dir, 'runner-home', '.pullboard-runner', 'repos');
  const received = readdirSync(repos).filter(name => name.endsWith('.git')).some(name => existsSync(join(repos, name, 'refs', 'pullboard', 'candidates', head)));
  assert.ok(received, 'the runner was sent the folder commit');
});

test('clause 2: pullboard test on a free runner returns within the file run time plus 10 seconds [C7]', { timeout: 240_000 }, async () => { // budget: hang ceiling; the speed bar is the assertion below.
  const { box } = await runnerProject();
  const own = Date.now();
  const alone = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/timed.test.js'], { cwd: box.web, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')) });
  const ownMs = Date.now() - own;
  assert.equal(alone.status, 0, alone.stderr);
  assert.ok(ownMs >= SLEEP_MS, `the fixture file runs its known time (${ownMs} ms)`); // budget: the fixture's own run time is the measured baseline.
  const started = Date.now();
  const ran = box.run(box.web, 'test', 'test/timed.test.js', '--json');
  const ms = Date.now() - started;
  assert.equal(ran.code, 0, ran.err);
  assert.equal(JSON.parse(ran.out).runner, HOST, 'the file ran on the free runner');
  assert.ok(ms <= ownMs + 10_000, `pullboard test took ${ms} ms against the file's own ${ownMs} ms`); // budget: the item's bar, file run time plus 10 s.
});

test('without runners a local start waits for load under one per core and says so [C7]', async () => {
  const loads = [[9], [5], [3]];
  const waits = [];
  const start = await localLoadStart({ read: () => loads.shift(), cores: 4, wait: async ms => { waits.push(ms); }, pollMs: 5 });
  assert.deepEqual(waits, [5, 5], 'it waited while load was at or over the core count');
  assert.equal(start.load, 3);
  assert.match(start.note, /load-aware local start at load 3\.0 on 4 cores/u, 'the run says it started load-aware');
  const idle = await localLoadStart({ read: () => [0.5], cores: 4, wait: async () => assert.fail('an idle machine starts at once') });
  assert.equal(idle.waitedMs < 1000, true);
});
