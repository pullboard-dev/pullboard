/** Follow only the exact queued gate, never an unrelated later review verdict [V4,H16,E18]. */
import { setTimeout as pause } from 'node:timers/promises';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { submitHandoffRoot } from '../../../../../packages/sandbox/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';

const fs = fileSystemAdapter();

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

/** Return the actual saved canonical output only after native completion binds it to this source and sender. */
function completedResult(directory, job, item, id) {
  let submission;
  try { submission = JSON.parse(fs.readFile(join(directory, 'submission.json'), 'utf8')); }
  catch { throw new Refused('SUBMIT_HANDOFF_RESULT', `the final queued gate output is unavailable; run pullboard show ${id} to read its native receipt`); }
  if (item.item_built_by !== job.agentId || item.item_commit !== job.submitted
    || submission.id !== id || submission.commit !== job.submitted || !submission.gate) {
    throw new Refused('SUBMIT_HANDOFF_RESULT', `the final queued output does not match its native submission; run pullboard show ${id}`);
  }
  // Private artifact text is a report, never authority to relabel the native gate outcome.
  return { ...submission, queued: false, gate: { ...submission.gate, green: job.gateGreen === true } };
}

/** Finish at green, accepted known-main red, or a named refusal; never begin a review-verdict timer. The wait follows the pulled job row alone: no gate drive record or hand-off ticket is read. */
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
    // The job row alone says where the gate is: a queued or running row keeps waiting, and the next pass reads its final state [C7,V4].
    await pause(250);
  }
}
