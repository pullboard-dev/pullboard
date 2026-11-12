import { INFRA_HANDOFF_RECOVERY_ENGINE } from '../../../../../packages/state/light.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import { healthyExecutor } from '../../../../lib/index.js';
import { withHandoffQueueOrder } from '../../../../../packages/resources/index.js';
import { ensureHandoffDispatcher } from '../../../../../packages/resources/index.js';
import { queueHandoffLaunch } from '../../../../../packages/resources/index.js';
import { reserveHandoffTicket } from '../../../../../packages/resources/index.js';
import { handoffTicketWaiting } from '../../../../../packages/resources/index.js';
import { dropHandoffTicket } from '../../../../../packages/resources/index.js';
import { queuedElsewhere } from '../../../../../packages/resources/index.js';
import { recordHandoffQueue } from '../../../../../packages/resources/index.js';
import { replaceLostTicketOnce } from '../../../../../packages/resources/index.js';
import { prepareDeadHandoffRetry } from '../../../../../packages/items/index.js';
import { handoffToolsAllowed } from '../../../../../packages/items/index.js';
import { assertToolTreeRoom } from '../../../../../packages/items/index.js';
import { sweepToolTrees } from '../../../../../packages/items/index.js';
import { touchToolTree } from '../../../../../packages/items/index.js';
import { withFileLock } from '../../../../../packages/outbox/index.js';
import { git } from '../../../../../packages/git/index.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { exactStart } from '../../../../../packages/gate/index.js';
import { ensureDispatcher } from '../../../../../packages/drive/index.js';
import { DISPATCHER_JOB } from '../../../../../packages/drive/index.js';
import { gateDriveJobId } from '../../../../../packages/drive/index.js';
/** The drive cell's detector for gate drives that renew their lease with no step; the sentinel command shouts each as Stuck (#3661). */
export { stalledGateDriveFindings } from '../../../../../packages/drive/index.js';
import { releaseLease } from '../../../../../packages/jobs/index.js';
import { openBoard as openRawBoard } from '../../../../lib/index.js';
import { closeBoard as closeRawBoard } from '../../../../lib/index.js';
import { deadWorker } from '../alive.js';
import { readWorkerRecord } from '../alive.js';
/** Queue only after canonical Submit has checked the exact source, lane, bar and companion composition [V4]. */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  cpSync,
  renameSync,
  rmSync,
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
import { Refused } from '../../../../../packages/kernel/index.js';
import { refusalDocument } from '../../logic/step/words.js';
import { submitHandoff } from '../../../../../packages/store/index.js';
import { INFRASTRUCTURE_RETRY_LIMIT } from '../../../../../packages/store/index.js';
import { itemUrgent } from '../../../../../packages/store/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { reviewPacketRerun } from '../../../../../packages/verify/index.js';
import { handoffRecords } from '../../../../../packages/store/index.js';
import { withBoardRead } from '../context.js';
import { withBoard } from '../context.js';
import { ordered } from '../claim.js';
import { itemPatchDigest } from '../../../../../packages/items/index.js';
import { submitHandoffRoot } from '../../../../../packages/sandbox/index.js';
import { advanceIdleToolTree } from '../toolsnapshot.js';
import { keepToolsIndex } from '../toolsnapshot.js';
import { checkoutCommittedTools } from '../toolsnapshot.js';

/** Copy the Pullboard tree without its history and dependencies, cloning files where the disk allows. */
export function copyTools(toolRoot, target) {
  cpSync(toolRoot, target, { recursive: true, mode: constants.COPYFILE_FICLONE,
    filter: path => !['.git', 'node_modules'].includes(relative(toolRoot, path).split('/')[0]) });
}

/**
 * Write the tool root's committed tree, never its working tree, into `target`, with the index a later tooling commit
 * moves it by (#3663). Why: a seat runs Pullboard from its own item worktree, which is usually dirty, and an
 * uncommitted edit must never leak into a snapshot other gates share [C7].
 */
export function copyCommittedTools(toolRoot, target, commit = 'HEAD') {
  if (!checkoutCommittedTools(toolRoot, target, commit)) throw new Error(`tools snapshot of the committed tree ${commit} failed`);
}

/**
 * Rebuild a retry's vanished tools folder from the Pullboard commit its request captured.
 * Why: a retry whose tools were swept must not end GATE_INFRA_EXHAUSTED; the captured tooling commit is enough (#3716).
 *
 * @param {string} directory - The stopped job's folder holding request.json.
 * @returns {boolean} Whether the captured tools folder exists afterwards.
 */
export function rebuildCapturedTools(directory) {
  let request;
  try { request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8')); } catch { return false; }
  const { tools, toolRoot, toolsCommit } = request;
  if (typeof tools !== 'string') return false;
  if (existsSync(tools)) return true;
  if (!/^[0-9a-f]{40}$/u.test(toolsCommit ?? '') || typeof toolRoot !== 'string' || dirname(tools) !== tmpdir()
    || !handoffToolsAllowed(tools, request.job)) return false;
  try { toolsSnapshot(toolRoot, request.job, request.commonDir, { rebuild: { tools, commit: toolsCommit } }); } catch { /* The retry then retains the evidence. */ }
  return existsSync(tools);
}

/**
 * The tools a retried, recovered or relaunched gate runs: a snapshot of its tool root's current HEAD and that commit,
 * or null when the tool root is gone or has no commit, so the caller keeps the captured tools.
 *
 * Why: the gate's source is the submitted commit, but its machinery (drive, proof shards, resources, runners) must be
 * current; on 8 Nov retries reran submit-time tools for hours after main fixed them (8 Nov stale tools).
 *
 * @param {{ toolRoot?: string }} request - The captured request naming the Pullboard checkout that submitted.
 * @param {string} job - The job the tools are for, naming a private copy when the tool root is not a clean checkout.
 * @param {string} commonDir
 * @returns {{ tools: string, toolsCommit: string } | null}
 */
export function currentHandoffTools(request, job, commonDir) {
  const root = request?.toolRoot;
  if (typeof root !== 'string' || !existsSync(root)) return null;
  const head = tryGit(root, ['rev-parse', 'HEAD']);
  if (head.status !== 0 || !/^[0-9a-f]{40}$/u.test(head.stdout)) return null;
  return { tools: toolsSnapshot(root, job, commonDir), toolsCommit: head.stdout };
}

/** The refresh a retry preparation calls: current tools for the retry's job, from the stopped request's tool root. */
function retryTools(ctx) { return (id, request) => currentHandoffTools(request, id, ctx.info.commonDir); }

/** How many times a running gate's dead worker is relaunched on the same job before the gate ends as infrastructure. */
export const RUNNING_RELAUNCH_LIMIT = 2;

/**
 * Relaunch a running gate whose worker died, on the same job: the new driver resumes the gate's drive job from its last
 * recorded section. Refuses SUBMIT_HANDOFF_RECOVERY, which ends the gate as today, once RUNNING_RELAUNCH_LIMIT
 * relaunches are spent or when the captured request or tools cannot be proved.
 *
 * Why: on 8 Nov 71 of 111 infrastructure stops were SUBMIT_HANDOFF_DEAD, mostly running gates whose worker died; each
 * lost its recorded sections and waited for a full retry, though the worker already resumes a running job (#3995).
 *
 * @param {any} ctx
 * @param {number} itemId
 * @param {{ id: string, commit: string }} current - The running hand-off record.
 * @param {{ relaunches: number, owner?: string | null }} worker - Its driver record.
 * @param {string} directory - The job's folder holding request.json.
 */
async function relaunchRunningGate(ctx, itemId, current, worker, directory) {
  const relaunches = worker.relaunches ?? 0;
  if (relaunches >= RUNNING_RELAUNCH_LIMIT) {
    throw new Refused('SUBMIT_HANDOFF_RECOVERY', `the running worker exited without a terminal result, again after ${relaunches} relaunches`);
  }
  rebuildCapturedTools(directory);
  let request;
  try { request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8')); }
  catch { throw new Refused('SUBMIT_HANDOFF_RECOVERY', 'the running worker exited without a terminal result, and its captured request is unreadable'); }
  if (request.job !== current.id || request.item !== itemId || request.commit !== current.commit || request.commonDir !== ctx.info.commonDir
    || !handoffToolsAllowed(request.tools, current.id) || !existsSync(request.tools)
    || dirname(realpathSync(request.tools)) !== realpathSync(tmpdir())) {
    throw new Refused('SUBMIT_HANDOFF_RECOVERY', 'the running worker exited without a terminal result, and its captured request or tools cannot be proved');
  }
  // The dead driver is proven gone, so its drive lease is freed now; the relaunched driver is admitted at once, not
  // refused GATE_DRIVE_LEASED for the up to 2 minutes the dead lease would take to lapse.
  if (worker.owner) withBoard(ctx, board => releaseLease(board.db, gateDriveJobId(current.id), worker.owner));
  await launchCapturedWorker(directory, request.tools, ctx.info.commonDir, current, relaunches + 1);
  ctx.io.say(`relaunched running submit #${itemId}; its gate resumes from its last recorded section`);
}

/** Folders and files whose git ids decide which tooling a worker runs; tests and docs are not among them. */
const TOOLING_PATHS = ['bin', 'apps', 'packages', 'src', 'package.json'];
/**
 * A digest of the git ids of what a worker runs (bin, apps, packages, src and package.json at HEAD). Why: two commits
 * with the same tooling trees need one snapshot, and a merge of main that changed only tests or docs must copy nothing [C7].
 */
function toolingDigest(toolRoot) {
  const ids = TOOLING_PATHS.map(path => {
    const id = tryGit(toolRoot, ['rev-parse', `HEAD:${path}`]);
    return id.status === 0 && /^[0-9a-f]{40}$/u.test(id.stdout) ? `${path}=${id.stdout}` : `${path}=absent`;
  });
  return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 40);
}

/**
 * The tools folder a gate runs from. A git checkout of Pullboard, clean or dirty, shares one snapshot per tooling tree under the OS
 * temp dir, built from its committed HEAD tree and copied only when absent (into a temp sibling, then renamed, so no submit sees half a copy); anything else
 * gets a private per-job copy (only a tool root with no resolvable HEAD does). Why: 71% of submits on 6 Nov copied privately because seat roots were dirty; every submit copied 3,762 files, and keying by commit still copied one per submit
 * because each submit merges main first; the tooling trees change only a few times a day [C7].
 *
 * @param {string} toolRoot
 * @param {string} job
 * @param {string} [commonDir]
 * @param {{ copy?: (toolRoot: string, target: string) => void, rebuild?: { tools: string, commit: string }, advance?: typeof advanceIdleToolTree }} [options] copy is injectable so a test can count copies; rebuild restores a vanished folder from a captured commit (#3716); advance moves an idle snapshot instead of a whole copy (#3663)
 * @returns {string}
 */
export function toolsSnapshot(toolRoot, job, commonDir, { copy, copyCommitted = copy ?? copyCommittedTools, rebuild, advance = advanceIdleToolTree } = {}) {
  copy ??= copyTools;
  const head = tryGit(toolRoot, ['rev-parse', 'HEAD']);
  const top = tryGit(toolRoot, ['rev-parse', '--show-toplevel']);
  const clean = rebuild !== undefined || head.status === 0 && /^[0-9a-f]{40}$/u.test(head.stdout) && top.status === 0
    && realpathSync(top.stdout) === realpathSync(toolRoot);
  const shared = rebuild?.tools ?? (clean ? join(tmpdir(), `pullboard-handoff-tools-${toolingDigest(toolRoot)}`) : null);
  if (shared && existsSync(shared)) {
    touchToolTree(shared);
    // The reuse path is the usual one; it sweeps too, so stale snapshots go on the next submit, not only on the next copy.
    sweepToolTrees({ commonDirs: [commonDir].filter(Boolean) });
    return shared;
  }
  if (!clean) {
    assertToolTreeRoom({ commonDirs: [commonDir].filter(Boolean) });
    const tools = mkdtempSync(join(tmpdir(), `pullboard-handoff-tools-${job}-`));
    copy(toolRoot, tools);
    return tools;
  }
  // An idle kept snapshot moved to this commit writes only the files that differ, proved by tree id (#3663).
  const commit = rebuild?.commit ?? head.stdout;
  // The move runs before the room check: that check's sweep removes idle snapshots, the very ones worth moving.
  const advanced = rebuild ? null : advance({ toolRoot, commit, job, temp: tmpdir() });
  if (advanced) sweepToolTrees({ commonDirs: [commonDir].filter(Boolean) });
  else assertToolTreeRoom({ commonDirs: [commonDir].filter(Boolean) });
  const staging = advanced?.path ?? mkdtempSync(join(tmpdir(), `pullboard-handoff-staging-${job}-`));
  try {
    if (!advanced) { copyCommitted(toolRoot, staging, commit); keepToolsIndex(toolRoot, staging, commit); }
    renameSync(staging, shared);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    // A concurrent submit won the rename; its finished snapshot is the same tooling.
    if (!existsSync(shared)) throw error;
  }
  return shared;
}

/**
 * Remove a withdrawn item's hand-off place in line, so the dispatcher never starts it; a record that was not queued or running holds none.
 *
 * @param {{ id: string, state: string } | null | undefined} handoff - The item's hand-off record read before the withdrawal.
 * @returns {void}
 */
export function dropWithdrawnHandoffTicket(handoff) {
  if (handoff && ['queued', 'running'].includes(handoff.state)) dropHandoffTicket(handoff.id);
}

/** Persist the immutable native request before detaching one worker; acknowledgment is not gate green. */
export async function enqueueSubmitHandoff(ctx, item, me, candidate) {
  const result = await withHandoffQueueOrder(() => withBoard(ctx, async board => {
    const queued = await ordered(ctx, board, 'queueSubmitHandoff', [item.item_id, {
    agentId: me.id, job: randomUUID(), main: candidate.main, executionCommit: candidate.companion?.commit ?? candidate.commit, executionTree: candidate.companion?.tree ?? candidate.tree, commit: candidate.commit, tree: candidate.tree,
    digest: item.item_frozen_digest, leaseMs: ctx.config.leaseMs, companionDigest: itemPatchDigest(board, item.item_id, candidate.commit),
  }]);
    // Keep the native move and reservation inside the machine ordering lock, before capture.
    return queued.created ? { ...queued, reservation: await reserveHandoffTicket(queued.job.id, { startOf: exactStart, urgent: itemUrgent(board, item.item_id) }) } : queued;
  }));
  const directory = dirname(submitHandoffRoot(ctx.info.commonDir, result.job));
  if (result.created) {
    git(ctx.info.root, ['update-ref', `refs/pullboard/submit-handoffs/${result.job.id}`, result.job.commit]);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Snapshot the running Pullboard build separately from the submitted project.
    // An external project need not contain Pullboard's own executable at all.
    const toolRoot = dirname(dirname(dirname(dirname(dirname(dirname(dirname(ctx.io.submitHandoffWorker))))))); // apps/cli/src/io/submit/handoff/worker.js [V32]
    const tools = toolsSnapshot(toolRoot, result.job.id, ctx.info.commonDir);
    writeFileSync(join(directory, 'request.json'), JSON.stringify({ item: item.item_id, job: result.job.id,
      commonDir: ctx.info.commonDir, origin: ctx.info.root, commit: result.job.commit, infra: candidate.infra,
      companion: candidate.companion, tools, toolRoot, toolsCommit: tryGit(toolRoot, ['rev-parse', 'HEAD']).stdout }) + '\n', { flag: 'wx', mode: 0o600 });
    await launchCapturedWorker(directory, tools, ctx.info.commonDir, result.job, 0, result.reservation);
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
  ctx.io.say(`queued gate for #${item.item_id} at ${result.job.commit}; take your next item now: pullboard next --take (the board returns this one to you only if its gate goes red)`);
  return 0;
}

/**
 * Queue every initial or recovery launch behind the same machine cap, without spawning a waiting worker, then make
 * sure a dispatcher runs: the board's dispatcher row (the drive cell's ensureDispatcher) decides. A live row means a
 * dispatcher drains this ticket; a lapsed one is taken here and a dispatcher is launched under that lease [C7].
 * Why the row is freed again when nothing launched: a dispatcher that already holds the machine drains every
 * repository's tickets, and a row held by nobody must not keep the next submit from launching one.
 * Why a recovery launch (no reservation) goes to the front of the line: its gate already waited its turn once and lost
 * it to a dead worker; on 8 Nov such retries waited up to 17 min behind routine submits [C7].
 */
async function launchCapturedWorker(directory, tools, commonDir, job, relaunches = 0, reservation) {
  const ticket = reservation ?? await reserveHandoffTicket(job.id, { startOf: exactStart, urgent: true });
  recordHandoffQueue(directory);
  queueHandoffLaunch({ directory, tools, commonDir, job: job.id, relaunches }, ticket);
  await ensureGateDispatcher(boardFileOf(commonDir), tools, commonDir);
}

/** The board file of the repository whose Git common directory this is. */
function boardFileOf(commonDir) { return join(commonDir, 'pullboard', 'board.sqlite'); }

/**
 * Take the board's dispatcher row when its lease lapsed and launch a dispatcher under it; leave a live row alone.
 *
 * @param {string} file - The board file.
 * @param {string} tools - The captured tools a launched dispatcher runs from.
 * @param {string} commonDir - The dispatcher's working directory, whose board holds its row.
 * @returns {Promise<boolean>} True when this call launched a dispatcher.
 */
export async function ensureGateDispatcher(file, tools, commonDir) {
  const owner = `dispatcher:${process.pid}:${randomUUID()}`;
  let taken = false;
  withRawBoard(file, board => ensureDispatcher(board.db, { owner, spawn: () => { taken = true; } }));
  if (!taken) return false;
  let launched = false;
  try { launched = await ensureHandoffDispatcher(tools, commonDir, { startOf: exactStart, owner }); }
  finally { if (!launched) withRawBoard(file, board => releaseLease(board.db, DISPATCHER_JOB, owner)); }
  return launched;
}

/** Run `work` on a board handle of its own, closed after, so the row is written outside any command's board. */
function withRawBoard(file, work) {
  const board = openRawBoard(file);
  try { return work(board); } finally { closeRawBoard(board); }
}

/** How long a hand-off may have no place in line and no live worker before the board requeues it as worker-gone. */
export const WORKER_GONE_GRACE_MS = 10 * 60_000;

/**
 * Whether a queued or running job has outlived the worker-gone grace with no place in line. Why: on 6 Nov five items
 * showed gate running or queued for 8 h with no queue entry and no worker, and their builders waited on a gate that no
 * longer existed (#3221).
 *
 * @param {{ id: string, state: string, at: string, startedAt?: string }} job
 * @param {{ now?: number, waiting?: (job: string) => boolean }} [ports]
 * @returns {boolean}
 */
export function goneHandoff(job, { now = Date.now(), waiting = handoffTicketWaiting } = {}) {
  const since = Date.parse(job?.startedAt ?? job?.at ?? '');
  return ['queued', 'running'].includes(job?.state) && Number.isFinite(since) && now - since > WORKER_GONE_GRACE_MS && !waiting(job.id);
}

/** A queued job past its launch grace with no worker record and no place in line will never start. */
export const LOST_LAUNCH_GRACE_MS = 2 * 60_000;

/**
 * Whether a queued job's launch was lost: it is older than the grace, so its submit reserved a place long ago, yet no
 * place in line remains. Why: the dispatcher admits the gate's driver on the board before it removes a ticket, so only a lost ticket
 * (an abandoned reservation or a ticket kept aside) leaves neither, and such a job held its claim for 5 h (#3121).
 */
export function lostQueuedLaunch(job, { now = Date.now(), waiting = handoffTicketWaiting } = {}) {
  const at = Date.parse(job?.at ?? '');
  return job?.state === 'queued' && Number.isFinite(at) && now - at > LOST_LAUNCH_GRACE_MS && !waiting(job.id);
}

/**
 * The worker record recovery judges: the written one, or a lost-launch record when the job has neither a worker nor a
 * place in line; null leaves the job alone. Why the second read: the dispatcher admits the driver and only then
 * removes the ticket, outside this guard, so a first read can miss a worker that a later ticket check no longer
 * sees; reading again after the ticket check finds it, and a live launch is never ended (#3153).
 *
 * @param {{ id: string, state: string, at: string }} job
 * @param {{ readWorker: () => object | null, waiting?: (job: string) => boolean, now?: number }} ports
 * @returns {object | null}
 */
export function queuedWorkerRecord(job, { readWorker, waiting = handoffTicketWaiting, now = Date.now() }) {
  const first = readWorker();
  if (first) return first;
  const lostRunning = job?.state === 'running' && goneHandoff(job, { now, waiting });
  if (!lostRunning && !lostQueuedLaunch(job, { now, waiting })) return null;
  const again = readWorker();
  if (again) return again;
  return { version: 1, job: job.id, pid: null, started: null, relaunches: 0,
    unstarted: { code: lostRunning ? 'HANDOFF_WORKER_GONE' : 'HANDOFF_TICKET_LOST', message: `the ${job.state} job has no worker record and no place in line` } };
}

/**
 * Recover only this authenticated builder's unfinished job, queued or running, outside the native writer. Why running
 * too: a worker that died mid-gate (#2469, ITEM_LEASE_LOST) left its job running forever, refusing every resubmit.
 */
async function recoverSubmitHandoff(ctx, itemId, actor, observed) {
  if (observed?.agentId !== actor || !['queued', 'running'].includes(observed.state)) return;
  const directory = dirname(submitHandoffRoot(ctx.info.commonDir, observed));
  // A hand-off whose folder was removed (a ghost gate) still ends: the lock and the retained refusal need the folder (#3221).
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return withFileLock(join(directory, 'recovery.guard.sqlite'), () => recoverDeadSubmitHandoff(ctx, itemId, actor, observed, directory));
}

/**
 * Whether a queued job shows neither its captured request nor a place in line, the only case in which its capture
 * may never have begun. Either one proves the launch was captured, so the machine's queue-order lock is taken only
 * when both are missing.
 * Why: that lock takes 1-18 s on a busy machine; on 8 Nov the health sweep took it once for every queued job, ran
 * past its 60 s bound on every pass, was killed before its running jobs and retries, and dead gates waited 22 min
 * (p50) for a restart [C7].
 *
 * @param {string} directory - The job's hand-off folder.
 * @param {string} job - The job id.
 * @param {{ waiting?: (job: string) => boolean }} [ports]
 * @returns {boolean}
 */
export function capturedLaunchUnseen(directory, job, { waiting = handoffTicketWaiting } = {}) {
  return !existsSync(join(directory, 'request.json')) && !waiting(job);
}

/**
 * The sweep's order: running jobs first, then queued ones, each by item. Why: a dead running gate is the one a
 * builder waits on, and a sweep that runs out of time must have reached it first [C7].
 *
 * @param {{ itemId: number, job: { state: string } }[]} jobs
 * @returns {{ itemId: number, job: { state: string } }[]}
 */
export function sweepOrder(jobs) {
  return [...jobs].sort((a, b) => Number(b.job.state === 'running') - Number(a.job.state === 'running') || a.itemId - b.itemId);
}

/** Re-observe under the per-job OS-released lock before any spawn or native failure move. */
async function recoverDeadSubmitHandoff(ctx, itemId, actor, observed, directory) {
  // The gate's driver record is its drive job on the board, never a file beside the hand-off [C7].
  const readWorker = () => withBoardRead(ctx, board => readWorkerRecord(board, observed));
  // A queued job placed in another machine queue is that queue's dispatcher's to judge; this one cannot see its ticket.
  if (observed.state === 'queued' && queuedElsewhere(directory)) return;
  const workerRecord = readWorker();
  if (!workerRecord && observed.state === 'queued' && capturedLaunchUnseen(directory, observed.id)) {
    const unlaunched = await withHandoffQueueOrder(() => {
      const current = withBoardRead(ctx, board => {
        const item = board.db.prepare('SELECT item_status,item_owner,item_frozen_digest FROM item WHERE item_id=?').get(itemId);
        const job = submitHandoff(board, itemId);
        return job?.id === observed.id && job.state === 'queued' && item?.item_status === 'claimed'
          && item.item_owner === actor && item.item_frozen_digest === observed.digest;
      });
      if (!current || existsSync(join(directory, 'request.json')) || handoffTicketWaiting(observed.id)) return false;
      // The dispatcher admits the driver on the board before it removes the ticket. Recheck both artifacts after the ticket read so
      // a just-started worker cannot be mistaken for a queue whose capture never began.
      return !readWorker() && !existsSync(join(directory, 'request.json')) && !handoffTicketWaiting(observed.id);
    });
    if (unlaunched) {
      await failUnlaunchedSubmitHandoff(ctx, itemId, actor, observed, 'both request.json and its driver record are missing');
      return;
    }
  }
  const worker = queuedWorkerRecord(observed, { readWorker });
  if (!worker || !deadWorker(worker, observed)) return;
  let owned = false;
  const current = withBoardRead(ctx, board => {
    const item = board.db.prepare('SELECT item_status,item_owner,item_frozen_digest FROM item WHERE item_id=?').get(itemId);
    const job = submitHandoff(board, itemId);
    owned = item?.item_status === 'claimed' && item.item_owner === actor && item.item_frozen_digest === observed.digest;
    return job?.id === observed.id && job.state === observed.state ? job : null;
  });
  if (!current) return;
  try {
    // A dead job on an item its seat no longer holds (released, withdrawn) still ends; it never shows running (#2627).
    if (!owned) throw new Refused('SUBMIT_HANDOFF_RECOVERY', 'the item is no longer claimed by the seat that queued it');
    // A running gate resumes: its drive job holds every recorded section, and a driver admitted to it carries on from
    // the last one, so a dead worker is relaunched on the same job instead of ending it SUBMIT_HANDOFF_DEAD (#3995).
    if (current.state === 'running') {
      await relaunchRunningGate(ctx, itemId, current, worker, directory);
      return;
    }
    // A lost place in line is re-placed once, at once; the marker counts it, so a second loss ends as infrastructure (#3153).
    if (worker.unstarted?.code === 'HANDOFF_TICKET_LOST' && !replaceLostTicketOnce(directory)) throw new Refused('SUBMIT_HANDOFF_RECOVERY', `${worker.unstarted.message}, again after it was re-placed`);
    if (worker.unstarted?.code !== 'HANDOFF_TICKET_LOST' && worker.relaunches >= 1) throw new Refused('SUBMIT_HANDOFF_RECOVERY', 'the captured worker exited again after its recovery launch');
    const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
    if (request.job !== current.id || request.item !== itemId || request.commit !== current.commit || request.commonDir !== ctx.info.commonDir
      || !handoffToolsAllowed(request.tools, current.id)
      || dirname(realpathSync(request.tools)) !== realpathSync(tmpdir())
      || existsSync(submitHandoffRoot(ctx.info.commonDir, current))) {
      throw new Refused('SUBMIT_HANDOFF_RECOVERY', 'the dead queued worker lacks safe captured tooling or already has a private source; preserve its evidence and resubmit the captured commit');
    }
    await launchCapturedWorker(directory, request.tools, ctx.info.commonDir, current, 1);
    ctx.io.say(`relaunched queued submit #${itemId} from its captured tools`);
    return;
  } catch (error) {
    // Past the grace with no place in line, a gone worker's job is requeued on its same source, queued or running (#3221).
    const gone = goneHandoff(current);
    let retry = null;
    if (owned && (current.state === 'running' || gone) && ENGINE_VERSION < INFRA_HANDOFF_RECOVERY_ENGINE) {
      try { rebuildCapturedTools(directory); retry = prepareDeadHandoffRetry(ctx.info.commonDir, itemId, current, directory, { refresh: retryTools(ctx) }); }
      catch (preparation) { ctx.io.err(`stopped submit #${itemId} cannot retry captured tools: ${preparation.message}`); }
    }
    const failure = { code: 1, ...refusalDocument(new Refused('SUBMIT_HANDOFF_DEAD',
      `${current.state} submit worker is dead and cannot be relaunched: ${error.message}; the gate stopped on infrastructure, never a builder red`,
      'the health sweep retries the captured candidate within its retry budget; the coordinator restores missing tools'), { caller: 'seat' }) };
    if (gone) failure.error.reason = 'worker-gone';
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, 'refusal.json'), JSON.stringify(failure) + '\n', { mode: 0o600 });
    let ended;
    try {
      ended = await withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [itemId,
        { agentId: actor, job: current.id, result: failure, ...(retry ? { retryJob: retry.id } : {}), reopenFirstRefusalMinutes: ctx.config.claim?.reopenFirstRefusalMinutes }]));
    } catch (completion) { retry?.discard(); throw completion; }
    if (retry && (ended?.id !== retry.id || ended.state !== 'queued')) retry.discard();
    if (retry && ended?.id === retry.id && ended.state === 'queued') {
      try { await launchCapturedWorker(retry.directory, retry.tools, ctx.info.commonDir, ended); }
      catch (launch) {
        ctx.io.err(`stopped submit #${itemId} recovery launch failed: ${launch.message}`);
        await withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [itemId,
          { agentId: actor, job: ended.id, result: failure }]));
      }
    }
  }
}

/** End a queue whose captured request and worker were never created, so its owner can submit the same source again. */
async function failUnlaunchedSubmitHandoff(ctx, itemId, actor, job, cause) {
  const failure = { code: 1, ...refusalDocument(new Refused('SUBMIT_HANDOFF_NOT_LAUNCHED',
    `queued submit worker was not launched: ${cause}; no gate ran`,
    'resubmit the same committed source to launch a fresh worker'), { caller: 'seat' }) };
  const directory = dirname(submitHandoffRoot(ctx.info.commonDir, job));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'refusal.json'), JSON.stringify(failure) + '\n', { mode: 0o600 });
  return withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [itemId,
    { agentId: actor, job: job.id, result: failure, reopenFirstRefusalMinutes: ctx.config.claim?.reopenFirstRefusalMinutes }]));
}

/**
 * The health sweep ends every queued or running handoff on the board whose worker process is gone, whichever seat
 * queued it and whatever its item's state now. Why: recovery ran only when the queuing seat itself ran next or submit
 * on an item it still held, so a seat that stopped, or an item released or withdrawn, left its job running for hours
 * (#2627). A live worker, or one whose identity cannot be read, is left alone.
 *
 * One hand-off that cannot be recovered never stops the pass: on 7 Nov a seat taken over by another (the board
 * refused AGENT_REPLACED) ended the sweep on its first job, and two gates read running with no worker for hours
 * (#3450). Each failure is recorded on stderr and the rest are still recovered; a replaced seat's job is skipped,
 * and any other failure is raised after the pass so the sweep exits non-zero and the dispatcher runs it again.
 *
 * @param {object} ctx - The CLI context of the repository's main checkout.
 * @param {{ list?: Function, recover?: Function, recoverInfrastructure?: Function, returnNoVerdict?: Function }} [ports] - How unfinished hand-offs
 *   are listed and recovered; the defaults read and write the real board.
 * @returns {Promise<number>} How many unfinished hand-offs the sweep looked at.
 */
export async function sweepDeadSubmitHandoffs(ctx, { list = unfinishedSubmitHandoffs, recover = recoverSubmitHandoff, recoverInfrastructure = recoverInfrastructureHandoffs, returnNoVerdict = returnNoVerdictHandoffs } = {}) {
  const jobs = sweepOrder(list(ctx));
  let failure = null;
  for (const { itemId, job } of jobs) {
    try { await recover(ctx, itemId, job.agentId, job); }
    catch (error) {
      const skipped = error?.code === 'AGENT_REPLACED';
      ctx.io.err(`[HANDOFF_SWEEP] #${itemId} ${skipped ? 'skipped' : 'not recovered'}: ${error?.message ?? error}`);
      if (!skipped) failure ??= error;
    }
  }
  await recoverInfrastructure(ctx);
  await returnNoVerdict(ctx);
  if (failure) throw failure;
  return jobs.length;
}

/**
 * Every item's current hand-off record on the board, read once from the job tables where the records live [C7].
 * Why through submitHandoff: it applies the engine floor, so an old-engine board lists none, as it always did.
 *
 * @param {any} board
 * @returns {{ itemId: number, job: Record<string, any> }[]}
 */
function boardHandoffs(board) {
  return [...handoffRecords(board.db).keys()].sort((a, b) => a - b)
    .map(itemId => ({ itemId, job: submitHandoff(board, itemId) })).filter(row => row.job);
}

/** Every queued or running submit hand-off on the board, with its item id. */
function unfinishedSubmitHandoffs(ctx) {
  return withBoardRead(ctx, board => boardHandoffs(board).filter(row => ['queued', 'running'].includes(row.job.state)));
}

/**
 * Whether a hand-off finished 'submitted' with no green gate for the item's current submitted head. Why: a submit
 * whose proof was red only in cases that also fail on main is recorded with gateGreen false, so no review packet is
 * stored and every reviewer is refused NO_REVIEW_PACKET while the item sits in review for hours (#3448). A head with a
 * stored review packet is reviewable: a gate red only in main's named cases stores one (#3449), and returning such
 * an item bounced good work on 11 Nov (#5774, #5287).
 *
 * @param {{ state?: string, gateGreen?: boolean, submitted?: string, commit?: string } | null} job
 * @param {{ item_status?: string, item_commit?: string | null } | null} item
 * @param {boolean} [packet] - whether a review packet is stored for the item's head
 * @returns {boolean}
 */
export function noVerdictHandoff(job, item, packet = false) {
  return !packet && job?.state === 'submitted' && job.gateGreen !== true && item?.item_status === 'submitted'
    && typeof item.item_commit === 'string' && item.item_commit === (job.submitted ?? job.commit);
}

/** Whether the board stores a review packet for the item's submitted head. */
function storedPacket(ctx, item) {
  return Boolean(item?.item_commit) && reviewPacketRerun(ctx.info.commonDir, item) !== null;
}

/**
 * Return every item whose hand-off ended with no gate verdict to its builder: the coordinator reopens it with the
 * named reason HANDOFF_NO_VERDICT and shouts the builder. Each item is re-read inside the writer before it moves.
 *
 * @param {object} ctx - The CLI context of the main checkout.
 * @returns {Promise<number>} How many items were returned.
 */
export async function returnNoVerdictHandoffs(ctx) {
  const stranded = withBoardRead(ctx, board => boardHandoffs(board)
    .filter(({ itemId, job }) => { const item = getItem(board, itemId); return noVerdictHandoff(job, item, storedPacket(ctx, item)); }).map(({ itemId }) => itemId));
  let returned = 0;
  for (const itemId of stranded) {
    try {
      returned += await withBoard(ctx, async board => {
        const job = submitHandoff(board, itemId), item = getItem(board, itemId);
        if (!noVerdictHandoff(job, item, storedPacket(ctx, item))) return 0;
        const head = item.item_commit.slice(0, 12);
        const note = `HANDOFF_NO_VERDICT: hand-off ${job.id} ended submitted at ${head} with no green gate, so no review packet exists and every reviewer is refused NO_REVIEW_PACKET; returned to its builder ${item.item_built_by ?? 'unknown'}`;
        await ordered(ctx, board, 'reopen', [itemId, { agentId: 'coordinator', note }]);
        if (item.item_built_by) {
          await ordered(ctx, board, 'shout', [{ from: 'coordinator', to: item.item_built_by, lanes: [],
            text: `#${itemId} is back with you (HANDOFF_NO_VERDICT): its gate at ${head} ended with no green verdict, so it could not be reviewed. Read pullboard show ${itemId}, make its proof green, then claim and submit again.` }]);
        }
        return 1;
      });
    } catch (error) { ctx.io.err(`no-verdict hand-off #${itemId} was not returned: ${error.message}`); }
  }
  return returned;
}

/** Next may recover this seat's queued or running claims whose worker is gone, never another seat's or a live gate. */
export async function recoverOwnSubmitHandoffs(ctx, actor) {
  const jobs = withBoardRead(ctx, board => board.db.prepare("SELECT item_id FROM item WHERE item_status='claimed' AND item_owner=?").all(actor)
    .map(row => ({ itemId: row.item_id, job: submitHandoff(board, row.item_id) })).filter(row => ['queued', 'running'].includes(row.job?.state)));
  for (const { itemId, job } of jobs) await recoverSubmitHandoff(ctx, itemId, actor, job);
}

/**
 * Before a submit compares sources, retire this seat's own handoff for the item when its worker is gone, so a dead
 * job never refuses the next submit with SUBMIT_HANDOFF_PENDING; a live worker is left alone.
 */
export async function recoverItemSubmitHandoff(ctx, itemId, actor) {
  const job = withBoardRead(ctx, board => submitHandoff(board, itemId));
  await recoverSubmitHandoff(ctx, itemId, actor, job);
}

/**
 * Stop a replaced worker's process group only when it is provably the recorded incarnation: it has a recorded start
 * time and a fresh exact start read right before the signal equals it. Why: a missing start, a reused PID or an
 * unreadable start could name another process; such a worker is left to end on its own (#2592). Returns whether it signaled.
 *
 * @param {{ job?: string, pid?: number, started?: string } | null} worker
 * @param {{ id: string }} job
 * @param {{ startOf?: (pid: number) => string | null, kill?: (pid: number, signal: string) => void }} [ports]
 */
export function stopReplacedWorker(worker, job, { startOf = exactStart, kill = process.kill.bind(process) } = {}) {
  if (worker?.job !== job.id || !Number.isSafeInteger(worker.pid) || worker.pid <= 1 || typeof worker.started !== 'string' || !worker.started) return false;
  let observed = null;
  try { observed = startOf(worker.pid); } catch { return false; }
  if (!observed || observed !== worker.started) return false;
  try { kill(-worker.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
  return true;
}

/**
 * A newer head replaces this seat's queued or running gate for the item: its worker's process group is stopped when it
 * is provably the recorded incarnation, which frees its gate and runner slot, and the job ends with SUBMIT_HANDOFF_REPLACED. Why: waiting on a gate whose source is
 * already superseded cost builders about 15 minutes each (#2592). Returns null, so the caller queues the new head.
 */
export async function replaceSubmitHandoff(ctx, itemId, actor, job) {
  if (job?.agentId !== actor || !['queued', 'running'].includes(job.state)) return job;
  const directory = dirname(submitHandoffRoot(ctx.info.commonDir, job));
  await withFileLock(join(directory, 'recovery.guard.sqlite'), async () => {
    // A queued job may not have a driver yet; its record is the gate's drive job on the board [C7].
    const worker = withBoardRead(ctx, board => readWorkerRecord(board, job));
    // The driver leads its own detached process group; the group holds its gate, its runner connection and its slot.
    stopReplacedWorker(worker, job);
    const failure = { code: 1, ...refusalDocument(new Refused('SUBMIT_HANDOFF_REPLACED',
      `a newer head replaced this gate at ${job.commit.slice(0, 12)}`, 'read the newer gate with pullboard show <id>'), { caller: 'seat' }) };
    writeFileSync(join(directory, 'refusal.json'), JSON.stringify(failure) + '\n', { mode: 0o600 });
    await withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [itemId,
      { agentId: actor, job: job.id, result: failure, reopenFirstRefusalMinutes: ctx.config.claim?.reopenFirstRefusalMinutes }]));
  });
  ctx.io.say(`replaced the queued gate for #${itemId} at ${job.commit.slice(0, 12)}; the new head gates instead`);
  return null;
}

/** Requeue stopped immutable jobs only after a healthy-executor probe; a private guard prevents duplicate launches [C7,V4]. */
export async function recoverInfrastructureHandoffs(ctx, { healthy = healthyExecutor, launch = launchCapturedWorker } = {}) {
  const jobs = withBoardRead(ctx, board => boardHandoffs(board)
    .filter(({ job }) => job.state === 'infrastructure' && ['GATE_INFRA_EXHAUSTED', 'SUBMIT_HANDOFF_DEAD'].includes(job.error?.code)
      && (job.infrastructureRetries ?? 0) < INFRASTRUCTURE_RETRY_LIMIT));
  if (!jobs.length || !(await healthy())) return 0;
  let recovered = 0;
  for (const { itemId, job } of jobs) {
    const directory = dirname(submitHandoffRoot(ctx.info.commonDir, job));
    await withFileLock(join(directory, 'recovery.guard.sqlite'), async () => {
      const current = withBoardRead(ctx, board => {
        const item = board.db.prepare('SELECT item_status,item_owner,item_frozen_digest,item_lease_until FROM item WHERE item_id=?').get(itemId);
        const saved = submitHandoff(board, itemId);
        return saved?.id === job.id && saved.state === 'infrastructure' && item?.item_status === 'claimed'
          && item.item_owner === job.agentId && item.item_frozen_digest === job.digest && item.item_lease_until > new Date().toISOString() ? saved : null;
      });
      if (!current) return;
      let retry;
      try { rebuildCapturedTools(directory); retry = prepareDeadHandoffRetry(ctx.info.commonDir, itemId, current, directory,
        { limit: INFRASTRUCTURE_RETRY_LIMIT, retries: current.infrastructureRetries ?? 0, refresh: retryTools(ctx) }); }
      catch (error) {
        ctx.io.err(`stopped submit #${itemId} retains captured evidence: ${error.message}`);
        await withBoard(ctx, board => ordered(ctx, board, 'startSubmitHandoff', [itemId, { agentId: job.agentId, job: job.id, unrecoverable: error.message }]));
        return;
      }
      if (!retry) return;
      let queued;
      try { queued = await withBoard(ctx, board => ordered(ctx, board, 'startSubmitHandoff', [itemId,
        { agentId: job.agentId, job: job.id, retryJob: retry.id }])); }
      catch (error) { retry.discard(); throw error; }
      if (queued.job?.id !== retry.id || queued.job.state !== 'queued') { retry.discard(); return; }
      recovered++;
      try { await launch(retry.directory, retry.tools, ctx.info.commonDir, queued.job); }
      catch (error) {
        const failure = { code: 1, ...refusalDocument(new Refused('SUBMIT_HANDOFF_DEAD',
          `recovery worker could not launch: ${error.message}`, 'the next health sweep retries within the captured budget'), { caller: 'seat' }) };
        await withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [itemId,
          { agentId: job.agentId, job: retry.id, result: failure }]));
      }
    });
  }
  return recovered;
}
