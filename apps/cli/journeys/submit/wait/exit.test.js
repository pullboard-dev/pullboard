/** The public wait flag ends at the actual gate outcome, independently of review [V4,B3]. */
/** @pullboard-test-loads apps/cli/pullboard.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openBoard } from '../../../../lib/index.js';
import { submitHandoff } from '../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { BIN } from '../../../tests/fixtures/submit/red.js';
import { fixture } from '../../../tests/fixtures/submit/red.js';
import { source } from '../../../tests/fixtures/submit/red.js';
import { submittedProof } from '../../../tests/fixtures/submit/red.js';
import { cli } from '../../../tests/fixtures/submit/red.js';

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
      await helpers.waitFor(() => handoffFinished(box), 'the actual queued worker cleanup', 120_000); // budget: hang ceiling for actual owned-worker cleanup before fixture removal.
    }
  });
  box = fixture(t, { check: 'node test/runner.js test/inherited.test.js', ...options });
  child = helpers.launch(box, box.builder, process.execPath,
    [BIN, 'submit', String(box.item), '--wait', '--no-next', '--json']);
  // budget: hang ceiling for the actual CLI exit; no elapsed-time assertion defines correct behavior.
  await helpers.waitFor(() => child.exitCode !== null || child.signalCode !== null, // budget: hang ceiling for observed actual CLI exit.
    'the final gate outcome to end submit without a reviewer', 30_000); // budget: fail only a hung CLI; no elapsed-time performance assertion.
  await child.closed;
  return { box, child, document: options?.handoff ? null : JSON.parse(child.stdoutText) };
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
  assert.equal(document.item_status, 'submitted');
  assert.ok(!document.verdicts?.length, 'no review is needed to end the gate wait');
}

test('submit --wait exits on an accepted known-main red and retains its repair owner [V4,B3]', { skip: 'PULL_GAP: un-skipped by #7104' }, async t => {
  const { box, child, document } = await submitToGate(t);
  assert.equal(child.exitCode, 0, child.stdoutText + child.stderrText);
  assert.equal(document.gate.green, false);
  assert.equal(document.gate.knownMainFailures.main, box.main);
  assert.equal(document.gate.knownMainReworks[0].item, box.rework);
  assert.equal(document.verdict, undefined);
  assertUnreviewed(box);
});

test('a claim-holding seat gets the queued acknowledgment at once and still reaches the exact known-main outcome through show [V4,B3,P7]', { skip: 'CONTROLLER_ONLY: deleted with #6833' }, async t => {
  const { box, child } = await submitToGate(t, { handoff: true });
  assert.equal(child.exitCode, 0, child.stdoutText + child.stderrText);
  assert.equal(JSON.parse(child.stdoutText).queued, true, 'a claim-holding seat gets the queued acknowledgment, not the final outcome');
  await helpers.waitFor(() => handoffFinished(box), 'the actual queued gate to finish', 120_000); // budget: hang ceiling for the actual queued gate to finish.
  const shown = cli(box, box.root, 'show', String(box.item), '--history');
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  const document = JSON.parse(shown.stdout);
  assertUnreviewed(box);
});
