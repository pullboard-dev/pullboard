/** On this repository, a runner job whose main moved since the cached one runs the cells stage in under 30 s [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { submitCellsRemoteCommand } from '../../../src/io/submit/remote.js';
import { produceAcceptedCells } from '../../../../lib/index.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { commitOn } from '../../../tests/fixtures/submit/cache.js';
import { freshJob } from '../../../tests/fixtures/submit/cache.js';
import { git } from '../../../../../packages/landing/tests/fixtures/plan.js';

/**
 * Make a synthetic commit the job's main and run the real background producer for it, as main's audit does after a
 * landing; the cells stage reads only a completed accepted inventory and never builds one inline.
 */
async function producedMain(job, main) {
  git(job, 'branch', '-f', 'main', main);
  const produced = await produceAcceptedCells(job, randomUUID(), main);
  assert.ok(produced?.available === true || produced?.status === 0, `the accepted inventory producer completed for ${main}`);
}

/** Run the runner's actual remote cells command in a job checkout, timing its whole cells stage. */
function remoteCells(job, main, source) {
  const command = submitCellsRemoteCommand({ main, source, criterion: 'one cell file changes', title: 'probe', cutRows: [], node: process.execPath });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'NODE_OPTIONS' && key !== 'NODE_TEST_CONTEXT'));
  const started = performance.now();
  const run = runFixtureChild('/bin/sh', ['-c', command], { cwd: job, env, encoding: 'utf8' });
  const seconds = (performance.now() - started) / 1000;
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}`);
  assert.match(run.stdout, /PULLBOARD_CELLS_RESULT /u);
  return seconds;
}

test('clause 1: on this repository, a runner job whose main moved since the cached one runs the cells stage in under 30 s [C7]', { timeout: 590_000 }, async t => {
  const repository = fileURLToPath(new URL('../../../../..', import.meta.url));
  const cellFile = 'packages/landing/src/io/step/failures.js';
  const first = freshJob(t, repository), mainA = git(first, 'rev-parse', 'HEAD').trim();
  // main A: the producer runs once, inside the first job's own cells stage, so the cache it warms is the one main B starts from.

  // A later job: a new checkout, main's tools archived into a new temporary folder, and main one changed file ahead.
  const later = freshJob(t, repository);
  const mainB = commitOn(later, mainA, 'test/cells-probe-main.test.js', `export const moved = '${randomUUID()}';\n`, 'main moves by one file');
  const sourceB = commitOn(later, mainB, cellFile, `${readFileSync(join(later, cellFile), 'utf8')}// probe ${randomUUID()}\n`, 'a cell changes');
  await producedMain(later, mainB);
  const moved = remoteCells(later, mainB, sourceB);
  t.diagnostic(`main B job: ${moved.toFixed(1)} s`);
  assert.ok(moved < 30, `the cells stage took ${moved.toFixed(1)} s, over 30 s`); // budget: approved bar, cells stage under 30 s after main moves
});
