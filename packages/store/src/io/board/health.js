import { hasPendingDispatchNotices } from "../../logic/board/receipts.js";
import { AUTOMATIC_DISPATCH_ENGINE } from "../../../../state/light.js";
/** Health mutation extracted without changing its transaction or notice order [A6]. */
import { ENGINE_VERSION } from "../../../../state/index.js";
import {
  itemById,
  listAgents,
} from "./query.js";
import { logEvent } from "./event/log.js";
import { Refused } from "../../../../kernel/index.js";
import { normalizedHealthFindings } from "../../logic/board/receipts.js";
import { healthFindingIdentity } from "../../logic/board/receipts.js";
import { healthTargets } from "../../logic/board/receipts.js";
import { deliverHealthNotices } from "../../logic/board/receipts.js";
import { HEALTH_SENTINEL_ENGINE } from "../../logic/board/receipts.js";
import { COORDINATOR } from "../../../../config/index.js";
import { PERSON } from "./query.js";
import { agentModel } from "./query.js";

import { CPU_SENTINEL_ENGINE } from "../../../../state/light.js";
import { hasPendingCpuNotices } from "../../logic/board/receipts.js";
import { REJECTED_WORK_RETURN_ENGINE } from "../../../../state/light.js";
/** Record one current health snapshot atomically, notifying each new or resolved episode once [A6]. */
export function applyHealthFindings(board, { agentId, observedRevision, findings, dispatch, returnRejected = false }, { atomic, insertShout, normalizedDispatch, rejectedWorkReturns }) {
  return atomic(board, () => {
    const existingMinimum = dispatch !== undefined || hasPendingDispatchNotices(board) ? AUTOMATIC_DISPATCH_ENGINE
      : hasPendingCpuNotices(board) || (Array.isArray(findings) && findings.some(finding => finding?.cause === 'AGENT_CPU')) ? CPU_SENTINEL_ENGINE : HEALTH_SENTINEL_ENGINE;
    const minimum = Math.max(existingMinimum, returnRejected !== false ? REJECTED_WORK_RETURN_ENGINE : 1);
    if ((board.executionEngineVersion ?? ENGINE_VERSION) < minimum) {
      throw new Refused('ENGINE_VERSION', `sentinel receipts require engine ${minimum}; upgrade Pullboard before scanning`);
    }
    if (!board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(agentId)) {
      throw new Refused('NOT_JOINED', 'join this board before recording a health scan: pullboard join <lane>');
    }
    const revision = board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS revision FROM event').get().revision;
    if (!Number.isSafeInteger(observedRevision) || observedRevision !== revision) {
      throw new Refused('HEALTH_SCAN_STALE', 'the board changed while health was scanning; run pullboard resume again');
    }
    if (typeof returnRejected !== 'boolean') throw new Refused('HEALTH_FINDINGS', 'returnRejected must be a boolean coordinator scan option');
    if (returnRejected && agentId !== COORDINATOR) {
      throw new Refused('COORDINATOR_ONLY', 'the coordinator returns unattended rejects; ask it to run pullboard sentinel run');
    }
    const active = normalizedHealthFindings(findings);
    const returns = returnRejected ? rejectedWorkReturns(board, findings) : [];
    const last = board.db.prepare("SELECT event_detail FROM event WHERE event_kind = 'health-scan' ORDER BY event_id DESC LIMIT 1").get();
    const previous = last ? JSON.parse(last.event_detail).active : [];
    const prospective = dispatch === undefined ? undefined : normalizedDispatch(dispatch);
    const dispatchChanged = prospective !== undefined && JSON.stringify(prospective) !== JSON.stringify(last ? JSON.parse(last.event_detail).dispatch ?? [] : []);
    const before = new Map(previous.map(finding => [healthFindingIdentity(finding), finding]));
    const after = new Map(active.map(finding => [healthFindingIdentity(finding), finding]));
    const added = active.filter(finding => !before.has(healthFindingIdentity(finding)));
    const resolved = previous.filter(finding => !after.has(healthFindingIdentity(finding)));
    const pending = last ? [...JSON.parse(last.event_detail).pendingCpu ?? [],
      ...(JSON.parse(last.event_detail).pendingDispatch ?? []).filter(finding => after.has(healthFindingIdentity(finding)))] : [];
    if (!added.length && !resolved.length && !pending.length && !dispatchChanged && !returns.length) return { added: [], resolved: [] };
    const agents = listAgents(board);
    const lanes = [...new Set(agents.map(agent => agent.agent_lane))];
    const engine = board.executionEngineVersion ?? ENGINE_VERSION;
    // The sentinel is no seat, so what it records names the model of the seat whose scan sent it.
    const model = agentModel(board, agentId) ?? 'unknown';
    /** Deliver through ordinary feed/inbox records without registering a synthetic worktree seat. */
    const log = (finding, cleared) => {
      const item = finding.item === null ? null : itemById(board, finding.item);
      logEvent(board, 'sentinel', cleared ? 'health-resolved' : 'health-failure', finding.item, {
        key: finding.key, cause: `refusal:${finding.cause}`, since: finding.since, subject: finding.subject,
        owner: finding.owner, commit: item?.item_commit ?? null, engine: HEALTH_SENTINEL_ENGINE, model,
      });
    };
    const deferred = deliverHealthNotices({ resolved, added, pending, engine, log, coordinator: COORDINATOR, shout: (to, text) => insertShout(board, { from: 'sentinel', to, text, lanes, detail: { model } }),
      targets: finding => healthTargets(finding, { engine, coordinator: COORDINATOR, person: PERSON, lanes, agents }) });
    for (const returned of returns) {
      const { item, ...detail } = returned;
      logEvent(board, agentId, 'reject_returned', item, { ...detail, engine: REJECTED_WORK_RETURN_ENGINE });
    }
    logEvent(board, agentId, 'health-scan', null, { active, ...(prospective === undefined ? {} : { dispatch: prospective }), ...(deferred === undefined ? {} : { pendingCpu: deferred.filter(finding => finding.cause === 'AGENT_CPU') }),
      ...(deferred?.some(finding => finding.cause === 'UNPAIRED_WORK') || last && JSON.parse(last.event_detail).pendingDispatch ? { pendingDispatch: deferred?.filter(finding => finding.cause === 'UNPAIRED_WORK') ?? [] } : {}), engine: HEALTH_SENTINEL_ENGINE });
    return { added: added.map(finding => finding.key), resolved: resolved.map(finding => finding.key) };
  });
}
