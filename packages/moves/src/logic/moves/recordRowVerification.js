/** Exact-row verifier operation; its actor is the actual joined caller [V4,H16]. */
import { SPEC_VERDICT_ENGINE } from "../../../../state/light.js";

/** Older replicas must refuse rather than lose independent verdict semantics. */
function minimumEngine() { return SPEC_VERDICT_ENGINE; }
/** Bind the canonical sender to the seat that recorded the verdict. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: 'recordRowVerification', engine: SPEC_VERDICT_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
    ROW_VERIFY: 'pullboard spec show <id>, then pullboard spec verify <id> accepted --reason "why"',
    ROW_VERIFY_PROVENANCE: 'draft the row through pullboard spec draft and join normally before verifying it',
    ROW_VERIFY_PENDING: 'ask the coordinator to run pullboard spec apply before recording a verifier verdict',
    ROW_VERIFY_SELF: 'ask an outside-parent verifier to run pullboard spec verify',
  }) });
