/** The public wait flag ends at the actual gate outcome, independently of review [V4,B3]. */
/** @pullboard-test-loads apps/cli/pullboard.js */
import assert from 'node:assert/strict';
import { driverRecord } from '../../../tests/fixtures/gate/driver.js';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { openBoard } from '../../../../lib/index.js';
import { submitHandoff } from '../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { BIN } from '../../../tests/fixtures/submit/red.js';
import { fixture } from '../../../tests/fixtures/submit/red.js';
import { source } from '../../../tests/fixtures/submit/red.js';
import { submittedProof } from '../../../tests/fixtures/submit/red.js';
import { cli } from '../../../tests/fixtures/submit/red.js';
import { runFixtureGit } from '../../../tests/fixtures/child.js';
import { exactStart } from '../../../../../packages/gate/index.js';

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

test('submit --wait exits on an accepted known-main red and retains its repair owner [V4,B3]', async t => {
  const { box, child, document } = await submitToGate(t);
  assert.equal(child.exitCode, 0, child.stdoutText + child.stderrText);
  assert.equal(document.gate.green, false);
  assert.equal(document.gate.knownMainFailures.main, box.main);
  assert.equal(document.gate.knownMainReworks[0].item, box.rework);
  assert.equal(document.verdict, undefined);
  assertUnreviewed(box);
});

test('submit --wait exits with the actual candidate-only gate refusal [V4,B3]', async t => {
  const { box, child, document } = await submitToGate(t, { candidate: source('candidate-only failure [G1]') });
  assert.equal(child.exitCode, 1, child.stdoutText + child.stderrText);
  assert.equal(document.error.code, 'GATE_RED');
  assert.equal(submittedProof(box), null);
});

test('a claim-holding seat gets the queued acknowledgment at once and still reaches the exact known-main outcome through show [V4,B3,P7]', async t => {
  const { box, child } = await submitToGate(t, { handoff: true });
  assert.equal(child.exitCode, 0, child.stdoutText + child.stderrText);
  assert.equal(JSON.parse(child.stdoutText).queued, true, 'a claim-holding seat gets the queued acknowledgment, not the final outcome');
  await helpers.waitFor(() => handoffFinished(box), 'the actual queued gate to finish', 120_000); // budget: hang ceiling for the actual queued gate to finish.
  const shown = cli(box, box.root, 'show', String(box.item), '--history');
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  const document = JSON.parse(shown.stdout);
  assertUnreviewed(box);
});

test('a queued wait names an actually lost worker before any gate admission [V4,B3]', async t => {
  let child;
  let barrier;
  let worker;
  let release;
  t.after(async () => {
    if (release) writeFileSync(release, 'release\n');
    if (worker?.started && exactStart(worker.pid) === worker.started) process.kill(worker.pid, 'SIGKILL');
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await child.closed;
    }
    if (barrier) await helpers.waitFor(() => exactStart(barrier.git) !== barrier.gitStart, // budget: hang ceiling for the owned Git child cleanup.
      'the owned checkout Git child to actually exit', 30_000); // budget: owned-child cleanup ceiling before fixture removal.
  });
  const box = fixture(t, { handoff: true });
  release = join(box.directory, 'checkout-release');
  const ready = join(box.directory, 'checkout-ready');
  const hook = join(box.root, '.git/hooks/post-checkout');
  const script = join(box.directory, 'checkout-barrier.mjs');
  writeFileSync(script, [
    "import { existsSync,writeFileSync } from 'node:fs';",
    `import { exactStart } from ${JSON.stringify(new URL('../../../../../packages/gate/index.js', import.meta.url).href)};`,
    "if(process.cwd().includes('/submit-handoffs/') && process.cwd().endsWith('/source')) {",
    ` writeFileSync(${JSON.stringify(ready)},JSON.stringify({git:process.ppid,gitStart:exactStart(process.ppid)}));`,
    ' const deadline=Date.now()+120000;',
    ` while(!existsSync(${JSON.stringify(release)})) { if(Date.now()>deadline) throw Error('checkout barrier unreleased'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); }`,
    '}',
  ].join('\n'));
  // init has no post-checkout hook; refuse to replace any guard if that contract changes.
  assert.equal(existsSync(hook), false);
  writeFileSync(hook, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(hook, 0o755);
  runFixtureGit(['config', 'core.hooksPath', join(box.root, '.git/hooks')], { cwd: box.root, env: box.env });
  child = helpers.launch(box, box.builder, process.execPath,
    [BIN, 'submit', String(box.item), '--wait', '--no-next', '--json']);
  await helpers.waitFor(() => existsSync(ready), 'the real private checkout barrier', 30_000); // budget: hang ceiling for the actual private checkout handshake.
  barrier = JSON.parse(readFileSync(ready, 'utf8'));
  assert.ok(barrier.gitStart, 'cleanup observes an exact owned Git incarnation');
  // @pullboard-board-file journey: locate the real enqueued worker without creating a native job or receipt.
  const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  let job;
  try { job = submitHandoff(board, box.item); } finally { board.db.close(); }
  assert.equal(job.state, 'queued', 'the checkout barrier precedes all gate holder/waiter admission');
  const boardFile = join(box.root, '.git/pullboard/board.sqlite');
  await helpers.waitFor(() => driverRecord(boardFile, job.id)?.started, 'the real driver incarnation record', 30_000); // budget: hang ceiling for actual owned-driver identity before signaling it.
  worker = driverRecord(boardFile, job.id);
  assert.ok(worker.started);
  assert.equal(exactStart(worker.pid), worker.started, 'only this owned fixture worker may be terminated');
  process.kill(worker.pid, 'SIGKILL');
  const diag = cli(box, box.builder, 'resume', '--diagnostics');
  const nxt = cli(box, box.builder, 'next', '--no-take');
  assert.fail(`DEBUG resume ${diag.status}\n${diag.stdout}${diag.stderr}\nNEXT ${nxt.status}\n${nxt.stdout}${nxt.stderr}`);
  assert.equal(submittedProof(box), null, 'a lost worker cannot fabricate a gate outcome');
});
