/** With landing.pipeline on, batch N+1 gates on main plus batch N's merge, observed in a real checkout [C7,#8937]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { pipelineBase } from '../../src/io/step/base.js';

const TRUNK = 'refs/heads/main';
const FIRST_AT = '2026-11-16T10:00:00.000Z';
const LATER_AT = '2026-11-16T10:05:00.000Z';

/** A real repository at main with batch A's merge (tipA) one commit above it, and the recorded batches over them. */
function batches(t, { stateA = 'ready' } = {}) {
  const repo = cellRepo(t, { real: true });
  const { root: dir } = privateFixtureFiles('pullboard-pipeline-base-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = repo.commit;
  repo.put('a.txt', 'batch A\n');
  const tipA = repo.commitAll();
  runFixtureGit(['reset', '-q', '--hard', main], { cwd: repo.root });
  const record = (id, startedAt, other = {}) => ({ id, state: 'gating', startedAt, branch: TRUNK, base: main, tip: main, items: [], ...other });
  const recorded = [record('A', FIRST_AT, { state: stateA, tip: tipA }), record('B', LATER_AT)];
  return { repo, main, tipA, recorded, dir, read: () => recorded, B: recorded[1] };
}

test('landing.pipeline-base.batch-gates-on-main-plus-prior-batch: clause 1: with landing.pipeline on, batch N+1 gates on main plus batch N merge [C7,#8937]', t => {
  const { repo, main, tipA, read, B, dir } = batches(t);
  const base = pipelineBase({ config: { landing: { pipeline: true } } }, B, { batches: read });
  assert.equal(base, tipA, 'the later batch gates on the earlier batch tip, which is main plus its merge');
  const root = join(dir, 'b');
  runFixtureGit(['worktree', 'add', '-q', '--detach', root, base], { cwd: repo.root });
  assert.ok(existsSync(join(root, 'a.txt')), 'the tree under gate holds batch A');
  assert.equal(runFixtureGit(['merge-base', main, base], { cwd: repo.root }), main, 'and still sits on main');
});

test('landing.pipeline-base.batch-gates-on-own-base: clause 1: with landing.pipeline off, or none in flight, a batch gates on its own base [C7,#8937]', t => {
  const { main, read, B, recorded } = batches(t);
  assert.equal(pipelineBase({ config: { landing: { pipeline: false } } }, B, { batches: read }), main);
  assert.equal(pipelineBase({ config: {} }, B, { batches: read }), main);
  assert.equal(pipelineBase({ config: { landing: { pipeline: true } } }, recorded[0], { batches: read }), main, 'the first batch has nothing below it');
  for (const state of ['landed', 'blocked']) {
    const { main: base, read: other, B: later } = batches(t, { stateA: state });
    assert.equal(pipelineBase({ config: { landing: { pipeline: true } } }, later, { batches: other }), base, `a ${state} batch is not in flight`);
  }
});
