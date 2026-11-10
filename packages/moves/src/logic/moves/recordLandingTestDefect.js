import { TEST_ECONOMICS_ENGINE } from "../../../../state/light.js";
import { MAIN_AUDIT_ENGINE } from "../../../../state/light.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by recordLandingTestDefect, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_ENVIRONMENT_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (Object.hasOwn(args[0] ?? {}, 'auditSinceEventId')) return TEST_ECONOMICS_ENGINE;
  if (Object.hasOwn(args[0] ?? {}, 'requireOpen')) return MAIN_AUDIT_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  return LANDING_ENVIRONMENT_ENGINE;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "recordLandingTestDefect", order: 45, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "COORDINATOR_ONLY": "ask the coordinator to do it: pullboard shout coordinator --kind question \"<what you need>\"",
  "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "LAND_TEST_DEFECT": "commit a correction to the test named by the held defect, or ask the person for an expiring test waiver; then run pullboard land again"
}) });
