/** Placement reads trunk through the common Git dir or a fetch, and a Git read failure retries instead of refusing [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { requirePlannedSource } from '../../index.js';
import { fixture } from '../../../landing/tests/fixtures/plan.js';
import { git } from '../../../landing/tests/fixtures/plan.js';

test('a handoff whose source lacks the newest trunk commit still passes placement [C7]', t => {
  const { root, put } = fixture(t);
  const handoff = mkdtempSync(join(tmpdir(), 'pullboard-trunk-read-'));
  t.after(() => rmSync(handoff, { recursive: true, force: true }));
  git(handoff, 'clone', '-q', root, 'copy');
  const copy = join(handoff, 'copy');
  const source = git(copy, 'rev-parse', 'HEAD').trim();
  put('src/landed-mid-handoff.js', 'export const landed = true;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'main landed mid-handoff');
  const trunk = git(root, 'rev-parse', 'HEAD').trim();
  assert.notEqual(spawnSync('git', ['cat-file', '-e', trunk + '^{commit}'], { cwd: copy }).status, 0, 'the copy really lacks trunk');
  assert.doesNotThrow(() => requirePlannedSource(copy, trunk, source, { deferUnplaced: true }));
});

test('a forced ls-tree failure is an infrastructure error, never a builder refusal [C7]', t => {
  const { root } = fixture(t);
  const head = git(root, 'rev-parse', 'HEAD').trim();
  let thrown;
  try { requirePlannedSource(root, '0'.repeat(40), head); } catch (error) { thrown = error; }
  assert.ok(thrown, 'an unreadable trunk still stops placement');
  assert.notEqual(thrown.name, 'Refused');
  assert.equal(thrown.code, 'GIT_READ_INFRASTRUCTURE');
  assert.equal(thrown.retryable, true);
  assert.match(thrown.message, /presence could not be read from Git/);
});

test('a failed-then-successful trunk read repeats the queued analysis instead of refusing the builder [C7]', () => {
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=never refuses the builder', 'apps/cli/journeys/submit/analysis.test.js'],
    { cwd: join(import.meta.dirname, '../../../..'), encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'NODE_TEST_CONTEXT')) });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^# pass 1$/mu, 'the runner-retry fixture really ran');
});

test('an infrastructure Git read stopping the queued gate is never returned to the builder as red [C7]', () => {
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=never returned to the builder as red', 'apps/cli/journeys/submit/handoff.test.js'],
    { cwd: join(import.meta.dirname, '../../../..'), encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'NODE_TEST_CONTEXT')) });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^# pass 1$/mu, 'the handoff completion fixture really ran');
});
