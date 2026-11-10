/** Versioned coordinator, computed-conflict and exact-reviewer reopen authority [V2,H16]. */
import { AGENT_GRANT_ENGINE } from "../../../../state/index.js";
import { SUBMITTED_CONFLICT_ENGINE } from "../../../../state/index.js";
import { Refused } from "../../../../kernel/index.js";

/** Preserve historical authority and refusal order without granting a caller assertion new authority. */
export function reopenAuthority(board, found, actor, options, withdrawn, { listAgents, verdictWithdrawalTarget, computedConflictProblem }) {
  const { forWithdrawal, forMerge, currentEngine, computedConflict, assertedConflict } = options;
  if (computedConflict !== undefined) return currentEngine >= AGENT_GRANT_ENGINE && assertedConflict === undefined
    ? computedConflictProblem(board, found, actor, computedConflict) : new Refused('COORDINATOR_ONLY', 'only the coordinator reopens submissions');
  if (forWithdrawal) { withdrawn(verdictWithdrawalTarget(board, found, actor)); return null; }
  if (forMerge && found.item_status === 'submitted' && currentEngine >= SUBMITTED_CONFLICT_ENGINE
    && currentEngine < AGENT_GRANT_ENGINE && listAgents(board).some(agent => agent.agent_id === actor)) return null;
  return actor === 'coordinator' ? null : new Refused('COORDINATOR_ONLY', 'only the coordinator reopens submissions');
}
