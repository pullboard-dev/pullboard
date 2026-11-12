import { atomic } from "../../event/log.js";
import { logEvent } from "../../event/log.js";
import { Refused } from "../../../../../../kernel/index.js";
import { landingFlakes } from "../../../../logic/board/landing/exceptions.js";
import { coordinatorOnly } from "../../../board.js";
import { addItem } from "../../add.js";

/** File one durable defect per flaky test and retain its source digest [B3,R3]. */
export function recordLandingFlake(board, { agentId, test, hash, names, lane, batchId }) {
  coordinatorOnly(agentId, 'files landing flakes');
  if (typeof test !== 'string' || !test || !/^[a-f0-9]{64}$/u.test(hash ?? '') || !Array.isArray(names) || !names.length || names.some((name) => typeof name !== 'string' || !name) || typeof batchId !== 'string') {
    throw new Refused('LAND_FLAKE', 'a flake needs its named test, exact source digest and failing names; inspect the landing log');
  }
  return atomic(board, () => {
    const existing = landingFlakes(board).find((entry) => entry.test === test);
    if (existing?.hash === hash) return existing;
    const item = existing?.item ?? addItem(board, { by: agentId, lane, title: `Flaky test: ${test}`,
      criterion: `${test} passes in a full gate and alone without retries; failures: ${names.join(', ')}`, route: 'strong' });
    const flake = { test, hash, names, item, batchId };
    logEvent(board, agentId, 'landing_flake', item, { flake });
    return flake;
  });
}
