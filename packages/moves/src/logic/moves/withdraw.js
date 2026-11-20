import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by withdraw, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { MAIN_RED_WITHDRAW_ENGINE } from "../../../../state/light.js";
import { WITHDRAW_AS_MET_ENGINE } from "../../../../state/light.js";
import { WITHDRAW_NEXT } from "../table/next.js";

/** Preserve historical floors while versioning the conditional expected-item write [H16]. */
function minimumEngine(args, board, at) {
  let floor = 1;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) floor = RIGOR_AUTO_ENGINE;
  else if (args[0]?.landingFence !== undefined) floor = LANDING_LEASE_ENGINE;
  else if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) floor = BOARD_SENTINEL_ENGINE;
  const redFloor = args[1]?.expected !== undefined ? MAIN_RED_WITHDRAW_ENGINE : 1;
  const metFloor = args[1]?.metCommit !== undefined ? WITHDRAW_AS_MET_ENGINE : 1;
  return Math.max(floor, redFloor, metFloor);
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "withdraw", order: 20, engine: 1,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: WITHDRAW_NEXT });
