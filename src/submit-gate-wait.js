/** Follow only the exact queued gate, never an unrelated later review verdict [V4,H16,E18]. */
import { setTimeout as pause } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { exactStart } from './gate.js';
import { submitHandoffRoot } from './submit-handoff-origin.js';
import { Refused } from './refused.js';

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

/** A missing, unreadable or reused process identity never attests a healthy continuing gate. */
function requireWorker(directory, jobId, id) {
  let worker;
  try { worker = JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8')); }
  catch { throw new Refused('SUBMIT_HANDOFF_RESULT', `the queued worker observation is unavailable; run pullboard show ${id}; its gate may still be running`); }
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
    if (!['queued', 'running'].includes(job.state) || item.item_owner !== job.agentId || item.item_status !== 'claimed') {
      throw new Refused('SUBMIT_HANDOFF_CHANGED', `the queued gate no longer owns #${id}; run pullboard show ${id}`);
    }
    // Observe native completion again after checking process death: completion can race the last worker exit.
    try { requireWorker(directory, jobId, id); }
    catch (error) {
      const final = observeJob(ctx, id, acknowledgment, jobId, ports);
      if (['green', 'submitted', 'red', 'incomplete'].includes(final.job.state)) continue;
      throw error;
    }
    await pause(250);
  }
}
