import { git } from './git.js';
/** Queue only after canonical Submit has checked the exact source, lane, bar and companion composition [V4]. */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBoard } from './cli-context.js';
import { ordered } from './cli/claim.js';
import { itemPatchDigest } from './item-patch-state.js';
import { submitHandoffRoot } from './submit-handoff-origin.js';

/** Persist the immutable native request before detaching one worker; acknowledgment is not gate green. */
export async function enqueueSubmitHandoff(ctx, item, me, candidate) {
  const result = await withBoard(ctx, board => ordered(ctx, board, 'queueSubmitHandoff', [item.item_id, {
    agentId: me.id, job: randomUUID(), main: candidate.main, executionCommit: candidate.companion?.commit ?? candidate.commit, executionTree: candidate.companion?.tree ?? candidate.tree, commit: candidate.commit, tree: candidate.tree,
    digest: item.item_frozen_digest, leaseMs: ctx.config.leaseMs, companionDigest: itemPatchDigest(board, item.item_id, candidate.commit),
  }]));
  const directory = dirname(submitHandoffRoot(ctx.info.commonDir, result.job));
  if (result.created) {
    git(ctx.info.root, ['update-ref', `refs/pullboard/submit-handoffs/${result.job.id}`, result.job.commit]);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, 'request.json'), JSON.stringify({ item: item.item_id, job: result.job.id,
      commonDir: ctx.info.commonDir, origin: ctx.info.root, commit: result.job.commit, infra: candidate.infra,
      companion: candidate.companion }) + '\n', { flag: 'wx', mode: 0o600 });
    const log = openSync(join(directory, 'worker.log'), 'a', 0o600);
    try {
      const worker = spawn(process.execPath, [fileURLToPath(new URL('./submit-handoff-worker.js', import.meta.url)), join(directory, 'request.json')],
        { cwd: ctx.info.root, detached: true, stdio: ['ignore', log, log], env: { ...process.env } });
      worker.unref();
    } finally { closeSync(log); }
  }
  if (ctx.submissionResult) ctx.submissionResult.queued = true;
  ctx.io.result?.({ queued: true, id: item.item_id, item: item.item_id, pin: `refs/pullboard/submit-handoffs/${result.job.id}`, gate: { queued: true, green: null }, commit: result.job.commit, tree: result.job.tree,
    companionDigest: result.job.companionDigest, state: result.job.state });
  ctx.io.say(`queued gate for #${item.item_id} at ${result.job.commit}; the board will wake the next actor when it finishes`);
  return 0;
}
