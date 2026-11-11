/** Freeze coordinator observations into exact rejection episodes, never receiver-local liveness [B13,H16]. */
import { Refused } from '../../../kernel/browser.js';

/** Find still-open rejected episodes eligible for the coordinator's canonical queue return. */
export function rejectedWorkReturns(board, findings, { withSeatPresence, withDerivedFamily }) {
  if (!Array.isArray(findings)) throw new Refused('HEALTH_FINDINGS', 'a health scan needs its finding list');
  const returned = new Set(board.db.prepare("SELECT event_detail FROM event WHERE event_kind='reject_returned'").all()
    .map(row => JSON.parse(row.event_detail).rejection));
  const results = [];
  for (const finding of findings) {
    if (finding.cause !== 'REWORK_UNCLAIMED' || finding.detail?.move !== 'reject') continue;
    const observation = finding.detail;
    const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(finding.item);
    const event = board.db.prepare("SELECT * FROM event WHERE item_id=? AND event_kind IN ('add','claim','release','submit','accept','reject','reopen','refreeze','escalate','withdraw') ORDER BY event_id DESC LIMIT 1").get(finding.item);
    if (!item || item.item_status !== 'open' || item.item_hold_reason || event?.event_kind !== 'reject'
      || observation.rejection !== event.event_id || observation.builder !== item.item_built_by
      || observation.commit !== item.item_commit || finding.since !== event.event_at) {
      throw new Refused('HEALTH_SCAN_STALE', 'the rejected work changed during its scan; run pullboard sentinel run again');
    }
    if (returned.has(event.event_id)) continue;
    const now = board.clock.now().getTime();
    const timedOut = now - Date.parse(event.event_at) >= 600_000;
    const observedAt = Date.parse(observation.observedAt);
    const heartbeatAge = observation.heartbeatAt === null ? Infinity : observedAt - Date.parse(observation.heartbeatAt);
    const inactive = ['idle', 'gone'].includes(observation.presence)
      && Number.isFinite(observedAt) && observedAt >= Date.parse(event.event_at) && observedAt <= now && heartbeatAge >= 600_000;
    if (!timedOut && !inactive) {
      throw new Refused('HEALTH_SCAN_STALE', 'the reject has neither a ten-minute wait nor an inactive-seat observation; scan health again');
    }
    if (!timedOut && board.executionEngineVersion === undefined) {
      const seat = withDerivedFamily(board, board.db.prepare('SELECT * FROM agent WHERE agent_id=?').get(item.item_built_by));
      if (seat && withSeatPresence(board, [seat])[0].presence === 'live') {
        throw new Refused('HEALTH_SCAN_STALE', 'the rejected builder is live again; scan health before returning its work');
      }
    }
    const note = board.db.prepare("SELECT verdict_note FROM verdict WHERE item_id=? AND verdict_decision='REJECT' ORDER BY verdict_id DESC LIMIT 1").get(item.item_id)?.verdict_note ?? '';
    returned.add(event.event_id);
    results.push({ item: item.item_id, rejection: event.event_id, builder: item.item_built_by,
      commit: item.item_commit, note, reason: timedOut ? 'timeout' : 'inactive',
      ...(timedOut ? {} : { presence: observation.presence, heartbeatAt: observation.heartbeatAt, observedAt: observation.observedAt }) });
  }
  return results;
}
