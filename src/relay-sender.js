/** Compare sealed actors with the relay's independently authenticated sender [H2,H16,B26]. */
import { Refused } from './refused.js';

/** Read only the actor field used by each public engine operation; unknown operations fail closed. */
export function relayMoveActor(move) {
  const args = move?.args;
  if (!Array.isArray(args)) return null;
  if (move.operation === 'addItem') return args[0]?.by ?? null;
  if (move.operation === 'shout') return args[0]?.from ?? null;
  if (move.operation === 'release') return args[1] ?? null;
  if (['reserveNextReview', 'addMilestone', 'recordRowDecisions', 'applyRowDecisions'].includes(move.operation)) return args[0]?.agentId ?? null;
  if (['appendFact', 'editItem', 'escalate', 'recordAttempt', 'claim', 'submit', 'reserveReview', 'verify', 'merged', 'withdraw', 'refreeze',
    'passDecision', 'answerDecision', 'holdLane', 'releaseLane', 'editMilestoneItems', 'moveMilestone', 'editMilestone', 'removeMilestone'].includes(move.operation)) return args[1]?.agentId ?? null;
  return null;
}

/** Make the same authorization decision on every device, without inspecting its shell or checkout. */
export function relaySenderProblem(move, sender, kind) {
  if (!sender || !['person', 'agent'].includes(sender.kind) || typeof sender.userId !== 'string' || !sender.userId.length || sender.userId.length > 256 ||
    (sender.kind === 'agent' && (typeof sender.agent !== 'string' || !sender.agent.length || sender.agent.length > 256))) {
    return new Refused('RELAY_SENDER', 'this relay record has no authenticated sender; restore attribution before replaying it');
  }
  if (move?.operation === 'shout' && move.args?.[0]?.answers != null) {
    return new Refused('RELAY_ANSWER', 'a sealed shout cannot answer or pass a decision; use pullboard answer <id> "<answer>" or pullboard pass <id> --note "<reason>" so the decision rules are checked');
  }
  if (sender.kind === 'person') return null;
  if (kind === 'snapshot' || move?.operation === 'recordRowDecisions' || move?.operation === 'answerDecision' && move.args?.[1]?.asPerson ||
    move?.operation === 'shout' && move.args?.[0]?.request || relayMoveActor(move) === 'person') {
    return new Refused('RELAY_PERSON_ONLY', `agent ${sender.agent} cannot make a person-only relay ${kind}; use the person's authenticated session`);
  }
  const actor = relayMoveActor(move);
  if (actor !== sender.agent) return new Refused('RELAY_SENDER_MISMATCH', `agent ${sender.agent} cannot act as ${typeof actor === 'string' ? actor : '(no declared agent)'}; send this operation as the authenticated agent`);
  return null;
}
