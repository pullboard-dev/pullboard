/** A tool tree created under the scratch root is accepted by handoff and recovery; unset keeps os.tmpdir() [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { sharedToolsTarget } from '../../src/io/submit/handoff.js';
import { scratchFolder } from '../../../../packages/config/index.js';
import { removeJobToolSnapshot } from '../../../../packages/items/index.js';
import { sweepToolTrees } from '../../../../packages/items/index.js';
import { temporaryRepository } from '../../tests/fixtures/board/submit.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';

/** Runs the body with PULLBOARD_SCRATCH set (or cleared), then restores it. */
function withScratch(value, body) {
  const before = process.env.PULLBOARD_SCRATCH;
  if (value === undefined) delete process.env.PULLBOARD_SCRATCH; else process.env.PULLBOARD_SCRATCH = value;
  try { return body(); } finally { if (before === undefined) delete process.env.PULLBOARD_SCRATCH; else process.env.PULLBOARD_SCRATCH = before; }
}

test('a tool tree created under scratch is accepted by handoff and recovery [C7]', t => {
  const { root } = privateFixtureFiles('pullboard-scratch-trees-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratch = join(root, 'scratch');
  mkdirSync(scratch);
  const real = realpathSync(scratch);
  const repo = temporaryRepository(t, 'pullboard-scratch-trees-repo-');
  withScratch(scratch, () => {
    assert.equal(dirname(sharedToolsTarget(repo).tools), real, 'handoff names its shared tool tree under scratch');
    const tools = scratchFolder('pullboard-handoff-tools-job1-');
    removeJobToolSnapshot({ job: 'job1', tools }, tools);
    assert.equal(existsSync(tools), false, 'recovery accepts the per-job tree under scratch and removes it');
    const old = scratchFolder('pullboard-handoff-tools-job2-');
    utimesSync(old, 1, 1);
    assert.deepEqual(sweepToolTrees({ live: () => false }), [old], 'the sweep looks in scratch by default');
  });
});

test('unset: the tool tree parent is os.tmpdir() as before [C7]', t => {
  const repo = temporaryRepository(t, 'pullboard-scratch-trees-unset-');
  withScratch(undefined, () => assert.equal(dirname(sharedToolsTarget(repo).tools), tmpdir()));
});
