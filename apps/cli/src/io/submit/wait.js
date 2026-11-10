/** Follow only the exact queued gate, never an unrelated later review verdict [V4,H16,E18]. */
import { setTimeout as pause } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { exactStart } from '../../../../../packages/gate/index.js';
import { handoffTicketWaiting } from '../../../../../packages/resources/index.js';
import { gateDriverEnded } from '../../../../../packages/drive/index.js';
import { gateDriverGone } from '../../../../../packages/drive/index.js';
import { readGateDrive } from '../../../../../packages/drive/index.js';
import { submitHandoffRoot } from '../../../../../packages/sandbox/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';

/** Read one exact native job without retaining a board lock across a sleep or process observation. */
function observeJob(ctx, id, acknowledgment, jobId, ports) {
  return ports.withBoardRead(ctx, board => {
    const job = ports.submitHandoff(board, id);
    const item = ports.getItem(board, id);
    if (!job || job.id !== jobId || job.commit !== acknowledgment.commit || job.tree !== acknowledgment.tree
      || item.item_frozen_digest !== job.digest) {
      throw new Refused('SUBMIT_HANDOFF_CHANGED', `the queued gate for #${id} changed; run pullboard show ${id} to read its actual result`);
    }
    return { job, item };
  });
}

/**
 * A missing, unreadable or reused process identity never attests a healthy continuing gate. The driver's identity is
 * its gate's drive job on the board; a driver that never started or ended is gone, and one whose lease lapsed is gone
 * when its process is [C7].
 */
function requireWorker(ctx, ports, jobId, id) {
  const worker = ports.withBoardRead(ctx, board => readGateDrive(board.db, jobId));
  if (!worker) throw new Refused('SUBMIT_HANDOFF_RESULT', `the queued worker observation is unavailable; run pullboard show ${id}; its gate may still be running`);
  // A lapsed lease alone is judged by the process below: a blocked driver stops renewing while it lives (#3836).
  if (gateDriverEnded(worker) || (worker.pid === null && gateDriverGone(worker, Date.now()))) throw new Refused('SUBMIT_HANDOFF_CHANGED', `queued gate job ${jobId} lost its worker before a final outcome; run pullboard show ${id}; remote cleanup remains unknown`);
  if (worker.version !== 1 || worker.job !== jobId || !Number.isSafeInteger(worker.pid) || worker.pid < 1
    || typeof worker.started !== 'string' || !worker.started) {
    throw new Refused('SUBMIT_HANDOFF_RESULT', `the queued worker identity is unavailable; run pullboard show ${id}; do not dispatch another copy`);
  }
  const current = exactStart(worker.pid);
  if (current && current === worker.started) return;
  let absent = Boolean(current && current !== worker.started);
  if (!current) {
    try { process.kill(worker.pid, 0); }
    catch (error) { absent = error.code === 'ESRCH'; }
  }
  if (absent) throw new Refused('SUBMIT_HANDOFF_CHANGED', `queued gate job ${jobId} lost its worker before a final outcome; run pullboard show ${id}; remote cleanup remains unknown`);
  throw new Refused('SUBMIT_HANDOFF_RESULT', `cannot observe the queued worker safely; run pullboard show ${id}; its gate may still be running`);
}

/** Return the actual saved canonical output only after native completion binds it to this source and sender. */
function completedResult(directory, job, item, id) {
  let submission;
  try { submission = JSON.parse(readFileSync(join(directory, 'submission.json'), 'utf8')); }
  catch { throw new Refused('SUBMIT_HANDOFF_RESULT', `the final queued gate output is unavailable; run pullboard show ${id} to read its native receipt`); }
  if (item.item_built_by !== job.agentId || item.item_commit !== job.submitted
    || submission.id !== id || submission.commit !== job.submitted || !submission.gate) {
    throw new Refused('SUBMIT_HANDOFF_RESULT', `the final queued output does not match its native submission; run pullboard show ${id}`);
  }
  // Private artifact text is a report, never authority to relabel the native gate outcome.
  return { ...submission, queued: false, gate: { ...submission.gate, green: job.gateGreen === true } };
}

/** Finish at green, accepted known-main red, or a named refusal; never begin a review-verdict timer. */
export async function waitForSubmitGate(ctx, id, acknowledgment, jobId, ports) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(jobId ?? '')) {
    throw new Refused('SUBMIT_HANDOFF_CHANGED', `the acknowledged queued gate identity is missing; run pullboard show ${id}`);
  }
  const directory = dirname(submitHandoffRoot(ctx.info.commonDir, { id: jobId }));
  for (;;) {
    const { job, item } = observeJob(ctx, id, acknowledgment, jobId, ports);
    if (job.state === 'ownership-wait') {
      const wait = ports.withBoardRead(ctx, board => ports.ownershipWaitForJob(board, job.id));
      if (!wait || wait.key !== job.ownershipWait || wait.commit !== job.executionCommit || wait.tree !== job.executionTree
        || wait.agentId !== job.agentId || wait.digest !== job.digest) {
        throw new Refused('SUBMIT_HANDOFF_RESULT', 'the ownership result must match its exact queued source');
      }
      const { receipts, job: _job, ...waitingOwner } = wait;
      ctx.io.result?.({ id, commit: wait.commit, queued: false, state: 'ownership-wait', waitingOwner });
      ctx.io.say(`#${id} waits on ${wait.owners.join(', ')} ownership; the builder claim is released`);
      return 0;
    }
    if (['green', 'submitted'].includes(job.state)) {
      const result = completedResult(directory, job, item, id);
      ctx.io.result?.(result);
      ctx.io.say(`gate finished for #${id}: ${result.gate.green ? 'green' : 'known main red'}; ${result.gate.report ?? ''}`);
      return 0;
    }
    if (['red', 'incomplete'].includes(job.state)) {
      if (!job.error?.code || !job.error?.message) throw new Refused('SUBMIT_HANDOFF_RESULT', `the final queued refusal is unavailable; run pullboard show ${id}`);
      throw new Refused(job.error.code, job.error.message.replace(/^\[[A-Z_]+\] /u, ''));
    }
    // Canonical submit and queue finalization are separate native transactions. A matching
    // submitted receipt may already exist while this same worker still records its final job state.
    const claimed = item.item_owner === job.agentId && item.item_status === 'claimed';
    const finalizing = item.item_status === 'submitted' && item.item_built_by === job.agentId
      && item.item_commit === job.executionCommit;
    const ownerWait = !claimed && !finalizing && ports.ownershipWait
      ? ports.withBoardRead(ctx, board => ports.ownershipWait(board, id)) : null;
    const routing = ownerWait?.job === job.id && ownerWait.commit === job.executionCommit
      && ownerWait.tree === job.executionTree && ownerWait.digest === job.digest;
    if (!['queued', 'running'].includes(job.state) || !(claimed || finalizing || routing)) {
      throw new Refused('SUBMIT_HANDOFF_CHANGED', `the queued gate no longer owns #${id}; run pullboard show ${id}`);
    }
    // Observe native completion again after checking process death: completion can race the last worker exit.
    try { requireWorker(ctx, ports, jobId, id); }
    catch (error) {
      // A job still holding its place in line, or admitted but not yet started, has no process yet; keep waiting [V4].
      const admitted = ports.withBoardRead(ctx, board => readGateDrive(board.db, jobId));
      if ((!admitted && handoffTicketWaiting(jobId)) || (admitted && admitted.pid === null && !gateDriverGone(admitted, Date.now()))) { await pause(250); continue; }
      const final = observeJob(ctx, id, acknowledgment, jobId, ports);
      if (['green', 'submitted', 'ownership-wait', 'red', 'incomplete'].includes(final.job.state)) continue;
      throw error;
    }
    await pause(250);
  }
}
