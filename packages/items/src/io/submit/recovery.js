/** Prepare a fresh private attempt from captured tools; a crashed job's dirty source and artifacts stay intact [C7,V4]. */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  constants,
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  statfsSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  join,
} from 'node:path';
import { sameCommonDir } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';
import { processMachineHome } from '../../../../kernel/light.js';
import { scratchFolder } from '../../../../config/index.js';
import { scratchRoot } from '../../../../config/index.js';

/** The shared snapshot's folder name: one clone per Pullboard commit, named by its 40-hex hash [C7]. */
const SHARED_TOOLS = /^pullboard-handoff-tools-[0-9a-f]{40}$/u;

/**
 * Remove only the executing job's own temporary tool snapshot, including aliased temporary roots. A shared commit
 * snapshot is never named for one job, so it stays for every other queued or running gate that names it [C7].
 * Why: this module already owns the snapshot folders' names and their sweep, so the one removal of a job's own copy lives with them.
 *
 * @param {{ job: string, tools?: string }} request - The executing job's captured request.
 * @param {string} tools - The running tools folder, which the caller found from where its own code was loaded.
 */
export function removeJobToolSnapshot(request, tools) {
  if (basename(tools).startsWith(`pullboard-handoff-tools-${request.job}-`)
    && dirname(realpathSync(tools)) === realpathSync(scratchRoot())
    && request.tools && realpathSync(request.tools) === realpathSync(tools)) {
    rmSync(tools, { recursive: true, force: true });
  }
}

/**
 * Whether a captured tools folder is one this job may run from: its own per-job copy or a shared commit snapshot.
 * Why: submit shares one snapshot per Pullboard commit across gates, so recovery must reuse it, not demand a job name.
 *
 * @param {string | undefined} tools - The request's tools folder.
 * @param {string} job - The job id whose per-job copy is also accepted.
 * @returns {boolean}
 */
export function handoffToolsAllowed(tools, job) {
  const name = basename(tools ?? '');
  return name.startsWith(`pullboard-handoff-tools-${job}-`) || SHARED_TOOLS.test(name);
}

/**
 * Whether a tools folder is a shared commit snapshot, which no single job owns or removes.
 *
 * @param {string | undefined} tools - A tools folder path.
 * @returns {boolean}
 */
export function sharedHandoffTools(tools) { return SHARED_TOOLS.test(basename(tools ?? '')); }

/** The age past which an unowned tool-tree copy in the OS temp dir is garbage [C7]. */
export const TOOL_TREE_MAX_AGE_MS = 60 * 60_000;

/** The free space a volume needs before another tool-tree copy (56 MB each) may start [C7]. */
export const TOOL_TREE_MIN_FREE_BYTES = 5 * 1024 ** 3;

const TOOL_TREE_NAME = /^pullboard-(?:handoff|compare)-tools-/u;

/**
 * Whether any running process names this folder on its command line: the live owner of a tool tree.
 * Why: a worker is launched from its own copy, so its argv proves it is still using it.
 *
 * @param {string} path - A tool-tree folder.
 * @returns {boolean}
 */
export function toolTreeHasLiveOwner(path) {
  const listing = spawnSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return listing.status === 0 && listing.stdout.includes(path);
}

/** How long a gate stopped on infrastructure keeps its tools folder while it waits for the recovery retry [C7]. */
const RECOVERY_RETRY_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Whether a stopped job's refusal says the gate died on infrastructure, so a health-sweep retry still needs its tools.
 * Why: the retry runs from the captured tools; the worker is gone and the job is no longer queued, so only this refusal names the folder (#3716).
 *
 * @param {string} file - The job's refusal.json.
 * @param {(file: string) => any} read - A tolerant JSON reader.
 * @param {number} now - The clock.
 * @returns {boolean}
 */
function awaitsRecoveryRetry(file, read, now) {
  const refusal = read(file);
  const code = refusal?.error?.code ?? refusal?.code;
  if (!['SUBMIT_HANDOFF_DEAD', 'GATE_INFRA_EXHAUSTED'].includes(code)) return false;
  try { return now - statSync(file).mtimeMs <= RECOVERY_RETRY_WINDOW_MS; } catch { return false; }
}

/**
 * The tool paths named by a queued launch ticket or by an unfinished submit-handoff request.json: owners with no process.
 * Why: a queued gate waits for the dispatcher with no worker, so `ps` alone would let the sweep delete the tools it will run from.
 *
 * @param {{ queue?: string, commonDirs?: string[], now?: number }} [options] - The machine queue, extra repositories to scan and the clock.
 * @returns {Set<string>}
 */
export function queuedToolOwners({ queue = join(processMachineHome(), 'handoff-queue'), commonDirs = [], now = Date.now() } = {}) {
  const owned = new Set();
  const roots = new Set(commonDirs);
  /** Read one JSON file, ignoring anything missing or damaged. */
  const read = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
  /** Record a tools path as owned. */
  const own = tools => { if (typeof tools === 'string') owned.add(tools); };
  try {
    for (const name of readdirSync(queue).filter(entry => entry.endsWith('.json') && !entry.startsWith('.'))) {
      const ticket = read(join(queue, name));
      own(ticket?.tools);
      if (typeof ticket?.commonDir === 'string') roots.add(ticket.commonDir);
    }
  } catch { /* No queue folder means no queued launches. */ }
  for (const commonDir of roots) {
    const jobs = join(commonDir, 'pullboard', 'submit-handoffs');
    let names = [];
    try { names = readdirSync(jobs); } catch { continue; }
    for (const job of names) {
      const directory = join(jobs, job);
      if (existsSync(join(directory, 'submission.json'))) continue;
      if (existsSync(join(directory, 'refusal.json')) && !awaitsRecoveryRetry(join(directory, 'refusal.json'), read, now)) continue;
      own(read(join(directory, 'request.json'))?.tools);
    }
  }
  return owned;
}

/**
 * Mark a shared tool tree as used now, so the sweep keeps it while submits keep naming it.
 *
 * @param {string} path - A tool-tree folder.
 */
export function touchToolTree(path) {
  try { const now = new Date(); utimesSync(path, now, now); } catch { /* A vanished tree is rebuilt by the caller. */ }
}

/**
 * Remove pullboard-handoff-tools-* and pullboard-compare-tools-* folders older than the limit that no process owns.
 * Why: 201 copies of 56 MB filled the coordinator disk when abandoned jobs left their trees behind.
 *
 * @param {{ temp?: string, now?: number, maxAgeMs?: number, queue?: string, commonDirs?: string[], live?: (path: string) => boolean }} [options] - Test seams.
 * @returns {string[]} The folders removed.
 */
export function sweepToolTrees({ temp = scratchRoot(), now = Date.now(), maxAgeMs = TOOL_TREE_MAX_AGE_MS, queue, commonDirs = [], live } = {}) {
  const removed = [];
  const queued = live ? new Set() : queuedToolOwners({ queue, commonDirs, now });
  const owned = live ?? (path => queued.has(path) || toolTreeHasLiveOwner(path));
  let names;
  try { names = readdirSync(temp).filter(name => TOOL_TREE_NAME.test(name)); } catch { return removed; }
  for (const name of names) {
    const path = join(temp, name);
    try {
      if (now - statSync(path).mtimeMs <= maxAgeMs || owned(path)) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch { /* One unreadable folder must not stop the sweep. */ }
  }
  return removed;
}

/**
 * Refuse to start another tool-tree copy when the temp volume is nearly full, after one sweep.
 *
 * @param {{ temp?: string, commonDirs?: string[], minFree?: number }} [options] - The repositories whose queued requests own tools.
 */
export function assertToolTreeRoom({ temp = scratchRoot(), commonDirs = [], minFree = Number(process.env.PULLBOARD_TOOLS_MIN_FREE_BYTES ?? TOOL_TREE_MIN_FREE_BYTES) } = {}) {
  sweepToolTrees({ temp, commonDirs });
  let free;
  try { const stat = statfsSync(temp); free = stat.bavail * stat.bsize; } catch { return; }
  if (free < minFree) {
    throw new Refused('TOOL_TREE_DISK_LOW', `only ${Math.floor(free / 1024 ** 2)} MB free in ${temp}; the sweep removed every unowned pullboard-handoff-tools-* and pullboard-compare-tools-* older than 60 minutes, so free space or retry once running jobs finish`);
  }
}

/** Validate source custody before copying any tools or offering a new native queue identity. */
export function prepareDeadHandoffRetry(commonDir, item, job, directory, { limit = 3, retries = job.recoveryRetries ?? 0, refresh = null } = {}) {
  if (retries >= limit) return null;
  const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
  if (request.job !== job.id || request.item !== item || request.commit !== job.commit || !sameCommonDir(request.commonDir, commonDir)
    || (request.companion?.commit ?? job.commit) !== job.executionCommit || (request.companion?.tree ?? job.tree) !== job.executionTree
    || !handoffToolsAllowed(request.tools, job.id)
    || dirname(realpathSync(request.tools)) !== realpathSync(scratchRoot())) {
    throw new Refused('SUBMIT_HANDOFF_RECOVERY', 'retain the stopped job: its captured tools or source identity cannot be proved');
  }
  const id = randomUUID();
  // The retry runs current tooling: a gate stopped by an infrastructure fault must not rerun the machinery that had it (8 Nov stale tools).
  const fresh = freshRetryTools(refresh, id, request);
  const shared = sharedHandoffTools(fresh?.tools ?? request.tools);
  if (fresh) { if (shared) touchToolTree(fresh.tools); }
  else if (shared) touchToolTree(request.tools); else assertToolTreeRoom({ commonDirs: [commonDir] });
  const tools = fresh?.tools ?? (shared ? request.tools : scratchFolder(`pullboard-handoff-tools-${id}-`));
  const target = join(dirname(directory), id);
  try {
    if (!fresh && !shared) cpSync(request.tools, tools, { recursive: true, mode: constants.COPYFILE_FICLONE });
    mkdirSync(target, { recursive: true, mode: 0o700 });
    writeFileSync(join(target, 'request.json'), JSON.stringify({ ...request, job: id, tools, ...(fresh ? { toolsCommit: fresh.toolsCommit } : {}) }) + '\n', { flag: 'wx', mode: 0o600 });
    /** Remove only this unqueued preparation if the captured native claim changed concurrently. */
    const discard = () => { if (!shared) rmSync(tools, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); };
    return { id, tools, directory: target, discard };
  } catch (error) { if (!shared) rmSync(tools, { recursive: true, force: true }); throw error; }
}

/**
 * The current tools a retry runs, from the caller's refresh, or null to keep the captured tools: no refresh, a refresh
 * that fails, or a folder that is neither this retry's own copy nor a shared snapshot in the OS temp dir.
 *
 * Why: the captured tools are the tooling of the submit; a retry that reuses them reruns machinery main has already
 * fixed (8 Nov: gates submitted before PROOF_MAX_SHARDS kept opening 18 runner controllers for hours) (8 Nov stale tools).
 *
 * @param {((id: string, request: object) => { tools: string, toolsCommit: string } | null) | null} refresh
 * @param {string} id - The retry's job id.
 * @param {object} request - The stopped job's captured request.
 * @returns {{ tools: string, toolsCommit: string } | null}
 */
function freshRetryTools(refresh, id, request) {
  if (typeof refresh !== 'function') return null;
  let fresh;
  try { fresh = refresh(id, request); } catch { return null; }
  if (!fresh || typeof fresh.tools !== 'string' || !/^[0-9a-f]{40}$/u.test(fresh.toolsCommit ?? '') || !handoffToolsAllowed(fresh.tools, id)) return null;
  try { return dirname(realpathSync(fresh.tools)) === realpathSync(scratchRoot()) ? fresh : null; } catch { return null; }
}
