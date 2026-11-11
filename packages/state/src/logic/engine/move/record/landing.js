import { COORDINATOR } from '../../../../../../config/index.js';
import { Refused } from '../../../../../../kernel/light.js';

/** Replace the coordinator's train request with the prepared landing it seals [H16]. */
export function prepareBefore(board, values, { ports }) {
  const request = values[0];
  if (request?.agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator seals a train landing');
  const prepared = request?.nativeBatch
    ? ports.prepareNativeTrainLanding(request?.batch?.root, board, request.nativeBatch, request?.receipt?.id)
    : ports.prepareTrainLanding(request?.batch?.root, board,
      request?.batch?.items?.map(item => item.id), request?.batch?.tip, request?.receipt?.id);
  values[0] = { ...prepared, ...(request?.landingFence === undefined ? {} : { landingFence: request.landingFence }) };
}
