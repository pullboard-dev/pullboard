import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by recordFlakeObservation, discovered without a shared registry edit [C7,V4,H16]. */
import {
  CI_FLAKE_ENGINE,
  NATIVE_FLAKE_ENGINE,
} from "../../../../state/light.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  return args[0]?.observation?.kind === 'ci' ? CI_FLAKE_ENGINE : NATIVE_FLAKE_ENGINE;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "recordFlakeObservation", order: 54, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "FLAKE_OBSERVATION_CHANGED": "keep the original observation unchanged; record a new gate failure with a new observation identity instead of replacing historical evidence",
  "NOT_JOINED": "join a lane from this worktree: pullboard join <lane> --model \"<model name>\" (see: pullboard lanes)"
}) });
