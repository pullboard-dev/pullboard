/** The public wait flag ends at the actual gate outcome, independently of review [V4,B3]. */
/** @pullboard-test-loads bin/pullboard.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openBoard } from '../src/native-board.js';
import { submitHandoff } from '../src/submit-handoff-read.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { BIN } from './submit-main-red-fixture.js';
import { fixture } from './submit-main-red-fixture.js';
import { source } from './submit-main-red-fixture.js';
import { submittedProof } from './submit-main-red-fixture.js';
import { cli } from './submit-main-red-fixture.js';

const helpers = createE2eHelpers();

/** Observe a real CLI exit; clean up its owned child before deleting the private repository. */
async function submitToGate(t, options) {
  let child;
  let box;
  t.after(async () => {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await child.closed;
    if (options?.handoff) {
      // Observe cleanup before removing a repository still owned by its detached worker.
      await helpers.waitFor(() => handoffFinished(box), 'the actual queued worker cleanup', 120_000);
    }
  });
  box = fixture(t, { check: 'node test/runner.js test/inherited.test.js', ...options });
  child = helpers.launch(box, box.builder, process.execPath,
    [BIN, 'submit', String(box.item), '--wait', '--no-next', '--json']);
  // A hang ceiling bounds regressions; no elapsed-time assertion defines correct behavior.
  await helpers.waitFor(() => child.exitCode !== null || child.signalCode !== null,
    'the final gate outcome to end submit without a reviewer', 30_000);
  await child.closed;
  return { box, child, document: JSON.parse(child.stdoutText) };
}

/** Inspect native job completion and its owned source checkout without granting proof authority. */
function handoffFinished(box) {
  // @pullboard-board-file journey: observe the actual detached worker's retained lifecycle.
  const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    const job = submitHandoff(board, box.item);
    return job && !['queued', 'running'].includes(job.state)
      && !existsSync(join(box.root, '.git/pullboard/submit-handoffs', job.id, 'source'));
  } finally { board.db.close(); }
}

/** Prove the canonical event exists while no independent review has been recorded. */
function assertUnreviewed(box) {
  assert.ok(submittedProof(box), 'the actual gate produced a canonical submission');
  const shown = cli(box, box.root, 'show', String(box.item), '--history');
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  const document = JSON.parse(shown.stdout);
  assert.equal(document.item.item_status, 'submitted');
  assert.ok(!document.verdicts?.length, 'no review is needed to end the gate wait');
}

test('submit --wait exits on an accepted known-main red and retains its repair owner [V4,B3]', async t => {
  const { box, child, document } = await submitToGate(t);
  assert.equal(child.exitCode, 0, child.stdoutText + child.stderrText);
  assert.equal(document.gate.green, false);
  assert.equal(document.gate.knownMainFailures.main, box.main);
  assert.equal(document.gate.knownMainFailures.failures[0].item, box.rework);
  assert.equal(document.verdict, undefined);
  assertUnreviewed(box);
});

test('submit --wait exits with the actual candidate-only gate refusal [V4,B3]', async t => {
  const { box, child, document } = await submitToGate(t, { candidate: source('candidate-only failure [G1]') });
  assert.equal(child.exitCode, 1, child.stdoutText + child.stderrText);
  assert.equal(document.error.code, 'GATE_RED');
  assert.equal(submittedProof(box), null);
});

test('queued submit --wait waits for the exact known-main outcome instead of returning its acknowledgment [V4,B3]', async t => {
  const { box, child, document } = await submitToGate(t, { handoff: true });
  assert.equal(child.exitCode, 0, child.stdoutText + child.stderrText);
  assert.notEqual(document.queued, true, 'a queue acknowledgment is not the final gate outcome');
  assert.equal(document.gate.green, false);
  assert.equal(document.gate.knownMainFailures.main, box.main);
  assert.equal(document.verdict, undefined);
  assertUnreviewed(box);
});
