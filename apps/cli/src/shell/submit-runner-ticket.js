import { queueHandoffLaunch } from '../../../../packages/resources/index.js';
import { reserveHandoffTicket } from '../../../../packages/resources/index.js';
import { effectiveRunners } from '../../../../packages/runners/index.js';
import { git } from '../../../../packages/git/index.js';
/** A runner hand-off leaves this machine one board write and one ticket naming the commit [C7]. */

/**
 * Whether a submit hands its whole gate to a runner: the machine opted in and a runner is registered. Why opt-in: until
 * the dispatcher records runner results, the local worker stays the default and the fallback with no runner.
 *
 * @param {{ gate?: { runnerHandoff?: boolean } }} settings - The machine settings.
 * @returns {boolean}
 */
export function runnerHandoffWanted(settings) {
  return settings?.gate?.runnerHandoff === true && effectiveRunners(settings).length > 0;
}

/**
 * Queue the runner ticket for a job whose board write is already made: pin the commit under a ref so a runner can
 * fetch it, and file one ticket naming it. Starts no worker and makes no checkout or tools copy here.
 *
 * @param {{ root: string, commonDir: string }} info - The submitting checkout.
 * @param {{ id: string, commit: string, tree: string }} job - The queued native job.
 * @param {number} item - The item id.
 * @param {{ reservation?: string, startOf?: (pid: number) => string }} [options] - A place already reserved in line.
 * @returns {Promise<string>} The ticket file name.
 */
export async function queueRunnerHandoffTicket(info, job, item, { reservation, startOf } = {}) {
  git(info.root, ['update-ref', `refs/pullboard/submit-handoffs/${job.id}`, job.commit]);
  const place = reservation ?? await reserveHandoffTicket(job.id, { startOf });
  return queueHandoffLaunch({ kind: 'runner', job: job.id, item, commit: job.commit, tree: job.tree, commonDir: info.commonDir }, place);
}
