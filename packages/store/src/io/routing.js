import { QUEUE_PREEMPT_ENGINE } from '../../../state/light.js';
import { ENGINE_VERSION } from '../../../state/index.js';
import { localDependencyIds } from '../../../items/index.js';
import { pendingSubmitHandoff } from './submit/handoff/records.js';
import { ineligibleReleaseIds } from './cooldown.js';
/** Plan main-red build offers without taking another seat's work or releasing a claim [C7,N2]. */
import * as store from "./board.js";

/**
 * Prefer an eligible free seat, otherwise ask the newest build holder to release through ordinary commands.
 * workingFiles is a Map, or a function returning one that runs only when a repair needs routing.
 */
export function mainRedBuildRouting(board, { priority = [], caller, runnable = false, routes, workingFiles = new Map(), pendingFromJobRow = false } = {}) {
  const items = store.listItems(board);
  const reviewing = new Set(items.filter(item => item.item_status === 'submitted').map(item => store.reviewHolder(board, item)).filter(Boolean));
  // A caller already reviewing resumes that reservation; main red must not interrupt review work.
  if (reviewing.has(caller)) return null;
  const enabled = (board.executionEngineVersion ?? ENGINE_VERSION) >= QUEUE_PREEMPT_ENGINE;
  const urgent = enabled ? board.db.prepare("SELECT meta_key FROM board_meta WHERE meta_key GLOB 'item_urgent:*' AND meta_value='on'").all().map(row => Number(row.meta_key.slice('item_urgent:'.length))) : [];
  const repairs = new Set([...priority, ...urgent].filter(id => items.some(item => item.item_id === id && item.item_status === 'open')));
  if (!repairs.size) return null;
  // Observing every claim's worktree costs a Git status each; only a board with a repair to route reads them (#2511).
  if (typeof workingFiles === 'function') workingFiles = workingFiles();
  const lanes = new Set(items.filter(item => repairs.has(item.item_id)).map(item => item.item_lane));
  const agents = store.listAgents(board).filter(seat => seat.agent_id !== 'coordinator'
    && lanes.has(seat.agent_lane) && ['live', 'idle'].includes(seat.presence));
  const candidates = [];
  for (const seat of agents) {
    const claims = items.filter(item => item.item_status === 'claimed' && item.item_owner === seat.agent_id);
    // A review reservation is work too; do not offer it as a free build seat or interrupt it.
    if (reviewing.has(seat.agent_id)) continue;
    if (claims.length > 1) continue;
    const claim = claims[0] ?? null;
    if (enabled && claim) {
      const observation = workingFiles.get(claim.item_id);
      // A clean tree alone is not waiting: require an actual unresolved prerequisite too.
      const waiting = localDependencyIds(claim).some(id => {
        const dependency = items.find(item => item.item_id === id);
        return dependency && !['verified', 'withdrawn'].includes(dependency.item_status);
      }) || store.foreignBlockers(board, claim).length > 0;
      if (!waiting || !observation || observation.unknown || observation.files.length || pendingSubmitHandoff(board, claim, { fromJobRow: pendingFromJobRow })) continue;
    }
    const omitIds = items.filter(item => !repairs.has(item.item_id) && item.item_id !== claim?.item_id).map(item => item.item_id);
    const selected = store.nextFor(board, { agentId: seat.agent_id, lane: seat.agent_lane,
      priority: [...repairs], omitIds: [...omitIds, ...ineligibleReleaseIds(board, seat.agent_id)], runnable, workingFiles, ...(routes ? { routes } : {}), ...(claim ? { afterRelease: claim.item_id } : {}) });
    if (!selected.item || !repairs.has(selected.item.item_id) || selected.item.item_lane !== seat.agent_lane) continue;
    // Renewals are separate events, so renewing a half-built item never makes it the newest build.
    const started = claim ? board.db.prepare("SELECT event_id FROM event WHERE event_kind='claim' AND item_id=? AND event_by=? ORDER BY event_id DESC LIMIT 1")
      .get(claim.item_id, seat.agent_id)?.event_id : null;
    if (claim && !Number.isSafeInteger(started)) continue;
    candidates.push({ seat, item: selected.item, claim, started, reasons: selected.reasons });
  }
  const free = candidates.filter(candidate => !candidate.claim)
    .sort((a, b) => Number(b.seat.agent_id === caller) - Number(a.seat.agent_id === caller)
      || a.seat.agent_id.localeCompare(b.seat.agent_id));
  const selected = free[0] ?? candidates.filter(candidate => candidate.claim)
    .sort((a, b) => b.started - a.started || a.seat.agent_id.localeCompare(b.seat.agent_id))[0];
  if (!selected) return null;
  const { seat, item, claim, reasons } = selected;
  return { item, seat, reasons, ...(claim
    ? { releaseRequest: { seat: seat.agent_id, item: claim.item_id, repair: item.item_id, path: seat.agent_path } }
    : { buildOffer: { seat: seat.agent_id, item: item.item_id, path: seat.agent_path } }) };
}
