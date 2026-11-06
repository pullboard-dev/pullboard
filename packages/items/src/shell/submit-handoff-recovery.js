/** Prepare a fresh private attempt from captured tools; a crashed job's dirty source and artifacts stay intact [C7,V4]. */
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  join,
} from 'node:path';
import { tmpdir } from 'node:os';
import { sameCommonDir } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';

/** The shared snapshot's folder name: one clone per Pullboard commit, named by its 40-hex hash [C7]. */
const SHARED_TOOLS = /^pullboard-handoff-tools-[0-9a-f]{40}$/u;

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

/** Validate source custody before copying any tools or offering a new native queue identity. */
export function prepareDeadHandoffRetry(commonDir, item, job, directory, { limit = 3, retries = job.recoveryRetries ?? 0 } = {}) {
  if (retries >= limit) return null;
  const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
  if (request.job !== job.id || request.item !== item || request.commit !== job.commit || !sameCommonDir(request.commonDir, commonDir)
    || (request.companion?.commit ?? job.commit) !== job.executionCommit || (request.companion?.tree ?? job.tree) !== job.executionTree
    || !handoffToolsAllowed(request.tools, job.id)
    || dirname(realpathSync(request.tools)) !== realpathSync(tmpdir())) {
    throw new Refused('SUBMIT_HANDOFF_RECOVERY', 'retain the stopped job: its captured tools or source identity cannot be proved');
  }
  const id = randomUUID();
  const shared = sharedHandoffTools(request.tools);
  const tools = shared ? request.tools : mkdtempSync(join(tmpdir(), `pullboard-handoff-tools-${id}-`));
  const target = join(dirname(directory), id);
  try {
    if (!shared) cpSync(request.tools, tools, { recursive: true, mode: constants.COPYFILE_FICLONE });
    mkdirSync(target, { recursive: true, mode: 0o700 });
    writeFileSync(join(target, 'request.json'), JSON.stringify({ ...request, job: id, tools }) + '\n', { flag: 'wx', mode: 0o600 });
    /** Remove only this unqueued preparation if the captured native claim changed concurrently. */
    const discard = () => { if (!shared) rmSync(tools, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); };
    return { id, tools, directory: target, discard };
  } catch (error) { if (!shared) rmSync(tools, { recursive: true, force: true }); throw error; }
}
