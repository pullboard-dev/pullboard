/** Whether this submit leaves the main merge and trunk merge to the queued gate job: only the command, only with submit.composeOnRunner on [C7,#10756]. */
import { submitComposeOnRunner } from '../../../../../../packages/config/index.js';
import { isSubmitHandoffWorker } from '../../../../../../packages/sandbox/index.js';

/**
 * The runner composes main and the head, so the command sends the head as it is.
 * Why not the worker: a handoff worker is the runner side of the same submit and always merges what it was sent.
 * @param {object} ctx - The command context.
 * @returns {boolean} True when the command must skip its main merge and trunk merge.
 */
export function composesOnRunner(ctx) {
  return !isSubmitHandoffWorker(ctx) && submitComposeOnRunner();
}
