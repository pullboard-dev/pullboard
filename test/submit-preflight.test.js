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
import { createE2eHelpers } from './e2e-helpers.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');

test('resubmitting a rejected head refuses HEAD_NOT_NEW before its slow check starts [V4,C7]', { timeout: 180_000 }, (t) => { // budget: the refused submit must return within 60 s; before #924 it waits on a 120 s check.
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
  const json = (result) => { assert.equal(result.code, 0, result.out + result.err); return JSON.parse(result.out); };
  json(box.run(box.repo, 'add', 'web', 'Build the page', '--criterion', 'the page is built', '--check', 'node check.cjs', '--json'));
  json(box.run(box.web, 'claim', '1', '--json'));
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/page.txt'), 'built\n');
  box.git(box.web, 'add', 'web/page.txt');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): build the page [G1]');
  json(box.run(box.web, 'submit', '1', '--json'));
  // An outside reviewer rejects that exact head.
  const reviewer = join(box.dir, 'api-1');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, box.git(box.web, 'rev-parse', 'HEAD'));
  json(box.run(reviewer, 'join', 'api', '--json'));
  json(box.run(reviewer, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--clause', 'the page is built', '--note', 'the page is not reachable', '--json'));
  json(box.run(box.web, 'claim', '1', '--json'));
  // Resubmit the same head with the check armed to run for minutes.
  rmSync(ran, { force: true });
  writeFileSync(slow, 'armed\n');
  const started = Date.now();
  const resubmit = spawnSync(process.execPath, [BIN, 'submit', '1', '--json'], { cwd: box.web, env: box.env, encoding: 'utf8', timeout: 60_000 });
  const seconds = (Date.now() - started) / 1000;
  assert.notEqual(resubmit.signal, 'SIGTERM', `the refusal came back before the 60 s limit, not after a check run (${seconds.toFixed(1)} s)`);
  assert.equal(JSON.parse(resubmit.stdout).error?.code, 'HEAD_NOT_NEW', resubmit.stdout + resubmit.stderr);
  assert.equal(existsSync(ran), false, `no check or test ran before the refusal: ${existsSync(ran) ? readFileSync(ran, 'utf8') : ''}`);
});
