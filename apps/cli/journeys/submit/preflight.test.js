/** Submit refuses a head it cannot accept before any check or test runs [V4,C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');

test('cli.journeys-submit-preflight.resubmitting-a-rejected-head-refuses-head: resubmitting a rejected head refuses HEAD_NOT_NEW before its slow check starts [V4,C7]', { timeout: 180_000 }, async (t) => { // budget: the refused submit must return within 60 s; before #924 it waits on a 120 s check.
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const ran = join(box.dir, 'check-runs.log');
  const slow = join(box.dir, 'slow-check');
  // The item's check records every run; once armed, it takes two minutes, as a real suite can.
  writeFileSync(join(box.repo, 'check.cjs'), `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(ran)}, 'ran\\n');
if (fs.existsSync(${JSON.stringify(slow)})) setTimeout(() => {}, 120000);
else process.exit(fs.existsSync('web/page.txt') && fs.readFileSync('web/page.txt', 'utf8').includes('built') ? 0 : 1);
`);
  box.git(box.repo, 'add', 'check.cjs');
  box.git(box.repo, 'commit', '-q', '-m', 'test: add the recorded check [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  /** Demand real command success and its versioned result. */
  const json = async (pending) => { const result = await pending; assert.equal(result.code, 0, result.out + result.err); return JSON.parse(result.out); };
  await json(fixtureAdd(box.runLocal, box.repo, 'web', 'Build the page', '--criterion', 'the page is built', '--check', 'node check.cjs', '--json'));
  await json(box.runLocal(box.web, 'claim', '1', '--json'));
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/page.txt'), 'built\n');
  box.git(box.web, 'add', 'web/page.txt');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): build the page [G1]');
  await json(box.runLocal(box.web, 'submit', '1', '--json'));
  // An outside reviewer rejects that exact head.
  const reviewer = join(box.dir, 'api-1');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, box.git(box.web, 'rev-parse', 'HEAD'));
  assert.equal(joinFixtureSeat(box, reviewer, 'api').code, 0); // the reviewer joins on the strong route, whatever model runs the gate.
  await json(box.runLocal(reviewer, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--clause', 'the page is built', '--note', 'the page is not reachable', '--json'));
  await json(box.runLocal(box.web, 'claim', '1', '--json'));
  // Resubmit the same head with the check armed to run for minutes.
  rmSync(ran, { force: true });
  writeFileSync(slow, 'armed\n');
  const started = Date.now();
  // Process-level: the wall-clock bound needs a real child that a 60 s timeout can kill.
  const resubmit = spawnSync(process.execPath, [BIN, 'submit', '1', '--json'], { cwd: box.web, env: box.env, encoding: 'utf8', timeout: 60_000 });
  const seconds = (Date.now() - started) / 1000;
  assert.notEqual(resubmit.signal, 'SIGTERM', `the refusal came back before the 60 s limit, not after a check run (${seconds.toFixed(1)} s)`);
  assert.equal(JSON.parse(resubmit.stdout).error?.code, 'HEAD_NOT_NEW', resubmit.stdout + resubmit.stderr);
  assert.equal(existsSync(ran), false, `no check or test ran before the refusal: ${existsSync(ran) ? readFileSync(ran, 'utf8') : ''}`);
});

/** A committed one-file project the preflight judges; the shared e2e box owns the repository and its cleanup. */
function preflightProject(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  mkdirSync(join(box.repo, 'bin/checks'), { recursive: true });
  mkdirSync(join(box.repo, 'packages/gate/data/baselines'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/gate/data/baselines/test-waits-baseline.json'), '{}');
  mkdirSync(join(box.repo, 'packages/x/src'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/x/src/a.js'), 'export const a = 1;\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: base for the preflight');
  return box;
}

test('cli.journeys-submit-preflight.submit-preflight-runs-every-registered-check: clause 1: submit --preflight runs every registered check in parallel and one run reports three different static failures [C7]', { timeout: 120_000 }, async (t) => {
  const { runPreflight, reportPreflight } = await import('../../src/io/submit/preflight.js');
  const { STATIC_CHECKS } = await import('../../../../packages/gate/heavy.js');
  const box = preflightProject(t);
  // Three different classes: an empty catch, a multi-binding import and a fixed wait in a test.
  writeFileSync(join(box.repo, 'packages/x/src/a.js'), "import { b, c } from './b.js';\nexport function a() { try { b(); } catch {}\n}\n");
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  writeFileSync(join(box.repo, 'test/w.test.js'), 'await new Promise(resolve => setTimeout(resolve, 500));\n');
  const report = await runPreflight(box.repo, ['packages/x/src/a.js', 'test/w.test.js']);
  const named = report.results.filter(row => row.failures.length).map(row => row.name);
  assert.ok(named.includes('import-style') && named.includes('empty-catch') && named.includes('test-waits'), `all three classes reported in one run: ${named.join(',')}`);
  assert.equal(report.results.length, STATIC_CHECKS.length, 'every registered check ran');
  const lines = [];
  assert.equal(reportPreflight(report, line => lines.push(line)), 1);
  assert.match(lines.at(-1), /^preflight red: \d+ of \d+ checks failed/u);
});

test('cli.journeys-submit-preflight.a-clean-change-passes-preflight-and: clause 2: a clean change passes preflight and it finishes under 15 seconds [C7]', { timeout: 120_000 }, async (t) => {
  const { runPreflight } = await import('../../src/io/submit/preflight.js');
  const box = preflightProject(t);
  const report = await runPreflight(box.repo, ['packages/x/src/a.js']);
  assert.equal(report.ok, true, JSON.stringify(report.results.filter(row => row.failures.length)));
  assert.ok(report.ms < 15000, `preflight took ${Math.round(report.ms)} ms`); // budget: the criterion requires under 15 s.
});
