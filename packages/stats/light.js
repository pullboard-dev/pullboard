import { createHash } from 'node:crypto';
import { AGENT_SESSION_IDS } from '../kernel/light.js';
import { AGENT_SHELL_MARKERS } from '../kernel/light.js';

/** Distinguish agent sessions, including one stable session for an agent shell with no identifier. */
export function agentSessionDigest(environment = process.env) {
  if (!AGENT_SHELL_MARKERS.some((name) => Boolean(environment[name]))) return null;
  const name = AGENT_SESSION_IDS.find((key) => Boolean(environment[key]));
  const identity = name ? [name, environment[name]] : ['agent-shell-without-session'];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export {
  hasInputSplit,
} from './src/logic/split.js';

/*
 * The stats that store, verify, pages and the CLI's exit rules read or write while a board command runs: no runner, agent, review or report readers,
 * so a hot command that opens the board never loads the whole stats cell [C7,R24].
 */
export { coordinatorMilestoneRelease } from './src/io/actions.js';
export { pipelineStats } from './src/logic/pipeline.js';
export { proofStats, proofAgentIds } from './src/io/main.js';
export { readCapacity } from './src/io/capacity.js';
export { budgetState, recordUsage } from './src/io/cost.js';
export { recordUsageBatch } from './src/io/cost/batch.js';
export { recordSharedUsage } from './src/io/cost/shared.js';
export { exitRulesDecision, exitContextDecision } from './src/logic/exit/rules/policy.js';
export { nativeToolCallIds, nativeLastPrompt } from './src/logic/exit/rules/calls.js';
export { sessionSource, sessionSnapshot, usageDifference } from './src/io/cost/session.js';
export { CAPACITY_VERSION, emptyCapacityCounter, appendCapacityCounter } from './src/logic/capacity/counter.js';
export { refreshCapacity } from './src/logic/capacity/refresh.js';
export { emptyReportCounter, appendReportCounter } from './src/logic/flow/report/counter.js';
export { FLOW_REPORT_VERSION, reportEvent, newReportPolicy } from './src/logic/flow/report.js';
export { roleOf, moveFlowItem, projectFlowStats, compareFlowWindows } from './src/logic/flow.js';
export { barStats } from './src/logic/bar.js';
