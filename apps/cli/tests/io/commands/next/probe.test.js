/** @pullboard-test-input source-cell apps/cli */
/** @pullboard-test-input apps/cli/pullboard.js */
/** The built CLI returns a claim, finished and idle answer with the documented exit codes [C7,#12807]. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fixture } from '../../../fixtures/next/take.js';
import { runFixtureChildAsync } from '../../../fixtures/child.js';
import { fileURLToPath } from 'node:url';

const IDLE_BUDGET_MS = 95_000;

/** Run the built CLI against an isolated fixture board. */
function runNext(box, cwd, ...args) {
  return runFixtureChildAsync(process.execPath, [fileURLToPath(new URL('../../../../pullboard.js', import.meta.url)), ...args], { cwd, env: box.env, encoding: 'utf8' });
}

/** Mark one fixture item verified through the board's guarded transition window. */
function verify(box, id) {
  const head = box.git(box.root, 'rev-parse', 'HEAD');
  const digest = 'd'.repeat(64), stamp = '2026-10-25T10:00:00.000Z';
  box.board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
    VALUES (?, ?, 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, ?)`).run(id, box.seats.sibling.id, head, digest, head, stamp);
  box.board.db.exec('INSERT INTO temp.moving VALUES (1)');
  box.board.db.prepare("UPDATE item SET item_status='verified', item_commit=?, item_frozen_digest=?, item_built_by=?, item_verified_by=?, item_verdict='ACCEPT' WHERE item_id=?")
    .run(head, digest, box.seats.builder.id, box.seats.sibling.id, id);
  box.board.db.exec('DELETE FROM temp.moving');
}

test('cli.io-commands-next.built-cli-contract: clause 3: the built CLI prints a claimed line with exit 0, a finished line with exit 3, and an idle line with exit 4 within 95 seconds [C7,#12807]', async t => {
  const claimBox = await fixture(t);
  claimBox.add('A claimable item for the native CLI probe');
  const claimed = await runNext(claimBox, claimBox.seats.actor.path, 'next');
  assert.equal(claimed.status, 0, `${claimed.stdout}\n${claimed.stderr}`);
  assert.match(claimed.stdout, /claimed #\d+/u);

  const finishedBox = await fixture(t);
  const item = finishedBox.add('A verified item for the native CLI probe');
  verify(finishedBox, item);
  const finished = await runNext(finishedBox, finishedBox.seats.actor.path, 'next', '--no-wait');
  assert.equal(finished.status, 3, `${finished.stdout}\n${finished.stderr}`);
  assert.match(finished.stdout, /board finished/u);

  const idleBox = await fixture(t, { projectConfig: { next: { idleMinutes: 1 } } });
  const began = performance.now();
  const idle = await runNext(idleBox, idleBox.seats.actor.path, 'next');
  const elapsed = performance.now() - began;
  const idleOutput = idle.stdout + idle.stderr;
  assert.equal(idle.status, 4, `${idle.stdout}\n${idle.stderr}`);
  assert.match(idleOutput, /\[IDLE_TIMEOUT\] nothing for this seat in 60 seconds/u, idleOutput);
  assert.ok(elapsed >= 60_000, `configured 60 second idle answer came after only ${elapsed} ms`); // budget: measured one-minute fixture setting, not a raised ceiling
  assert.ok(elapsed <= IDLE_BUDGET_MS, `idle answer took ${elapsed} ms`); // budget: approved row C7 requires idle within 95 seconds [#12807]
  console.log(`PULLBOARD_NEXT_PROBE ${JSON.stringify({ claimed: { arguments: ['next'], status: claimed.status, stdout: claimed.stdout.trim() }, finished: { arguments: ['next', '--no-wait'], status: finished.status, stdout: finished.stdout.trim() }, idle: { arguments: ['next'], status: idle.status, stdout: idle.stdout.trim(), stderr: idle.stderr.trim(), elapsedMs: Math.round(elapsed) } })}`);
});
