import { git } from './git.js';
import { once } from 'node:events';
import { exactStart } from './gate.js';
/** Queue only after canonical Submit has checked the exact source, lane, bar and companion composition [V4]. */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  cpSync,
  constants,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  relative,
} from 'node:path';
import { tmpdir } from 'node:os';
import { withBoard } from './cli-context.js';
import { ordered } from './cli/claim.js';
import { itemPatchDigest } from '../packages/items/index.js';
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
    // Snapshot the running Pullboard build separately from the submitted project.
    // An external project need not contain Pullboard's own executable at all.
    const toolRoot = dirname(dirname(ctx.io.submitHandoffWorker));
    const tools = mkdtempSync(join(tmpdir(), `pullboard-handoff-tools-${result.job.id}-`));
    cpSync(toolRoot, tools, { recursive: true, mode: constants.COPYFILE_FICLONE,
      filter: path => !['.git', 'node_modules'].includes(relative(toolRoot, path).split('/')[0]) });
    writeFileSync(join(directory, 'request.json'), JSON.stringify({ item: item.item_id, job: result.job.id,
      commonDir: ctx.info.commonDir, origin: ctx.info.root, commit: result.job.commit, infra: candidate.infra,
      companion: candidate.companion, tools }) + '\n', { flag: 'wx', mode: 0o600 });
    const log = openSync(join(directory, 'worker.log'), 'a', 0o600);
    try {
      const worker = spawn(process.execPath, [join(tools, 'src', 'submit-handoff-worker.js'), join(directory, 'request.json')],
        { cwd: ctx.info.commonDir, detached: true, stdio: ['ignore', log, log], env: { ...process.env } });
      // Capture one actual incarnation before acknowledging; this file grants no board or proof authority.
      await once(worker, 'spawn');
      const started = exactStart(worker.pid);
      writeFileSync(join(directory, 'worker.json'), JSON.stringify({ version: 1, job: result.job.id,
        pid: worker.pid, started }) + '\n', { flag: 'wx', mode: 0o600 });
      worker.unref();
    } finally { closeSync(log); }
  }
  const acknowledgment = { queued: true, id: item.item_id, item: item.item_id, pin: `refs/pullboard/submit-handoffs/${result.job.id}`, gate: { queued: true, green: null }, commit: result.job.commit, tree: result.job.tree,
    companionDigest: result.job.companionDigest, state: result.job.state };
  if (ctx.submissionResult) Object.assign(ctx.submissionResult,
    { queued: true, job: result.job.id, value: acknowledgment });
  ctx.io.result?.(acknowledgment);
  ctx.io.say(`queued gate for #${item.item_id} at ${result.job.commit}; the board will wake the next actor when it finishes`);
  return 0;
}
