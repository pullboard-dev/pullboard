import { withFileLock } from '../../../../packages/outbox/index.js';
import { git } from '../../../../packages/git/index.js';
import { once } from 'node:events';
import { exactStart } from '../../../../packages/gate/index.js';
/** Queue only after canonical Submit has checked the exact source, lane, bar and companion composition [V4]. */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  cpSync,
  realpathSync,
  readFileSync,
  existsSync,
  constants,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  relative,
  basename,
} from 'node:path';
import { tmpdir } from 'node:os';
import { Refused } from '../../../../packages/kernel/index.js';
import { refusalDocument } from '../core/next-step-words.js';
import { submitHandoff } from '../../../../packages/store/index.js';
import { withBoardRead } from './cli-context.js';
import { withBoard } from './cli-context.js';
import { ordered } from './cli/claim.js';
import { itemPatchDigest } from '../../../../packages/items/index.js';
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
    const toolRoot = dirname(dirname(dirname(dirname(dirname(ctx.io.submitHandoffWorker)))));
    const tools = mkdtempSync(join(tmpdir(), `pullboard-handoff-tools-${result.job.id}-`));
    cpSync(toolRoot, tools, { recursive: true, mode: constants.COPYFILE_FICLONE,
      filter: path => !['.git', 'node_modules'].includes(relative(toolRoot, path).split('/')[0]) });
    writeFileSync(join(directory, 'request.json'), JSON.stringify({ item: item.item_id, job: result.job.id,
      commonDir: ctx.info.commonDir, origin: ctx.info.root, commit: result.job.commit, infra: candidate.infra,
      companion: candidate.companion, tools }) + '\n', { flag: 'wx', mode: 0o600 });
    await launchCapturedWorker(directory, tools, ctx.info.commonDir, result.job);
  } else {
    await recoverSubmitHandoff(ctx, item.item_id, me.id, result.job);
  }
  const current = withBoardRead(ctx, board => submitHandoff(board, item.item_id));
  if (current?.id === result.job.id && current.state === 'red') throw new Refused(current.error.code, current.error.message, current.error.next);
  const acknowledgment = { queued: true, id: item.item_id, item: item.item_id, pin: `refs/pullboard/submit-handoffs/${result.job.id}`, gate: { queued: true, green: null }, commit: result.job.commit, tree: result.job.tree,
    companionDigest: result.job.companionDigest, state: result.job.state };
  if (ctx.submissionResult) Object.assign(ctx.submissionResult,
    { queued: true, job: result.job.id, value: acknowledgment });
  ctx.io.result?.(acknowledgment);
  ctx.io.say(`queued gate for #${item.item_id} at ${result.job.commit}; the board will wake the next actor when it finishes`);
  return 0;
}

/** Start only captured tooling by its canonical path; capture one incarnation before acknowledgment. */
async function launchCapturedWorker(directory, tools, commonDir, job, relaunches = 0) {
  const log = openSync(join(directory, 'worker.log'), 'a', 0o600);
  try {
    const worker = spawn(process.execPath, [join(realpathSync(tools), 'apps', 'lib', 'src', 'shell', 'submit-handoff-worker.js'), join(directory, 'request.json')],
      { cwd: commonDir, detached: true, stdio: ['ignore', log, log], env: { ...process.env } });
    await once(worker, 'spawn');
    const started = exactStart(worker.pid);
    try { writeFileSync(join(directory, 'worker.json'), JSON.stringify({ version: 1, job: job.id, pid: worker.pid, started, relaunches }) + '\n', { mode: 0o600 }); }
    catch (error) {
      const closed = once(worker, 'close');
      worker.kill('SIGTERM');
      await closed;
      throw new Refused('SUBMIT_HANDOFF_SOURCE', `queued worker stopped because its incarnation could not be retained: ${error.message}`);
    }
    worker.unref();
  } finally { closeSync(log); }
}

/** An absent process or a different exact incarnation proves death; unavailable identity never does. */
function deadWorker(worker, job) {
  if (worker?.job !== job.id || !Number.isSafeInteger(worker.pid) || worker.pid < 1) return false;
  try { process.kill(worker.pid, 0); }
  catch (error) { return error.code === 'ESRCH'; }
  const observed = exactStart(worker.pid);
  return Boolean(worker.started && observed && observed !== worker.started);
}

/** Recover only this authenticated builder's still-queued job, outside the native writer. */
async function recoverSubmitHandoff(ctx, itemId, actor, observed) {
  if (observed?.agentId !== actor || observed.state !== 'queued') return;
  const directory = dirname(submitHandoffRoot(ctx.info.commonDir, observed));
  return withFileLock(join(directory, 'recovery.guard.sqlite'), () => recoverDeadSubmitHandoff(ctx, itemId, actor, observed, directory));
}

/** Re-observe under the per-job OS-released lock before any spawn or native failure move. */
async function recoverDeadSubmitHandoff(ctx, itemId, actor, observed, directory) {
  let worker;
  try { worker = JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8')); }
  catch { return; }
  if (!deadWorker(worker, observed)) return;
  const current = withBoardRead(ctx, board => {
    const item = board.db.prepare('SELECT item_status,item_owner,item_frozen_digest FROM item WHERE item_id=?').get(itemId);
    const job = submitHandoff(board, itemId);
    return item?.item_status === 'claimed' && item.item_owner === actor && item.item_frozen_digest === observed.digest
      && job?.id === observed.id && job.state === 'queued' ? job : null;
  });
  if (!current) return;
  try {
    if (worker.relaunches >= 1) throw new Refused('SUBMIT_HANDOFF_RECOVERY', 'the captured worker exited again after its recovery launch');
    const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
    if (request.job !== current.id || request.item !== itemId || request.commit !== current.commit || request.commonDir !== ctx.info.commonDir
      || !basename(request.tools ?? '').startsWith(`pullboard-handoff-tools-${current.id}-`)
      || dirname(realpathSync(request.tools)) !== realpathSync(tmpdir())
      || existsSync(submitHandoffRoot(ctx.info.commonDir, current))) {
      throw new Refused('SUBMIT_HANDOFF_RECOVERY', 'the dead queued worker lacks safe captured tooling or already has a private source; preserve its evidence and resubmit the captured commit');
    }
    await launchCapturedWorker(directory, request.tools, ctx.info.commonDir, current, 1);
    ctx.io.say(`relaunched queued submit #${itemId} from its captured tools`);
    return;
  } catch (error) {
    const failure = { code: 1, ...refusalDocument(new Refused('SUBMIT_HANDOFF_DEAD',
      `queued submit worker is dead and cannot be relaunched: ${error.message}; read its worker.log, then claim and resubmit the captured source`), { caller: 'seat' }) };
    writeFileSync(join(directory, 'refusal.json'), JSON.stringify(failure) + '\n', { mode: 0o600 });
    await withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [itemId,
      { agentId: actor, job: current.id, result: failure, reopenFirstRefusalMinutes: ctx.config.claim?.reopenFirstRefusalMinutes }]));
  }
}

/** Next may recover this seat's queued claims, never another seat or an already-running gate. */
export async function recoverOwnSubmitHandoffs(ctx, actor) {
  const jobs = withBoardRead(ctx, board => board.db.prepare("SELECT item_id FROM item WHERE item_status='claimed' AND item_owner=?").all(actor)
    .map(row => ({ itemId: row.item_id, job: submitHandoff(board, row.item_id) })).filter(row => row.job?.state === 'queued'));
  for (const { itemId, job } of jobs) await recoverSubmitHandoff(ctx, itemId, actor, job);
}
