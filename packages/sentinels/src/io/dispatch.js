import { lineSettings } from "../../../state/light.js";
import { withLocalSeatPresence } from "../../../store/index.js";
/** Observe eligible work beside live free seats without claiming from a read [N2,A6]. */
import { join } from 'node:path';
import * as store from "../../../store/index.js";
import { repoInfo } from "../../../git/index.js";
import { localSeatSessionDigest } from "../../../seats/index.js";
import { ownSessionReviews } from "../../../verify/index.js";
import { dispatchWork } from "../../../store/index.js";
import { Refused } from "../../../kernel/index.js";
import { fileSystemAdapter } from '../../../fs/index.js';

/** The one file-system adapter this file reads through [C7]. */
const fs = fileSystemAdapter();

/** Validate the optional ordered prospective observations without changing historical receipts. */
export function normalizedDispatch(value) {
  if (!Array.isArray(value) || value.length > 10000) throw new Refused('HEALTH_FINDINGS', 'dispatch observations must be a bounded array; run the sentinel again');
  const seen = new Set();
  return value.map(entry => {
    if (!entry || typeof entry.seat !== 'string' || !entry.seat || entry.seat.length > 256
      || !Number.isSafeInteger(entry.item) || entry.item < 1 || typeof entry.review !== 'boolean'
      || !Number.isFinite(Date.parse(entry.since)) || seen.has(`${entry.seat}\0${entry.item}`)) {
      throw new Refused('HEALTH_FINDINGS', 'dispatch observations need a native seat, an item unique within that seat, and a start time; run the sentinel again');
    }
    seen.add(`${entry.seat}\0${entry.item}`);
    return { seat: entry.seat, item: entry.item, review: entry.review, since: new Date(entry.since).toISOString() };
  });
}

/** Retain an observed eligible pairing's first instant until eligibility or ownership actually changes. */
export function dispatchHealth(board, config = {}) {
  const row = board.db.prepare("SELECT event_detail FROM event WHERE event_kind='health-scan' ORDER BY event_id DESC LIMIT 1").get();
  const previous = row ? JSON.parse(row.event_detail).dispatch ?? [] : [];
  const active = row ? JSON.parse(row.event_detail).active ?? [] : [];
  const at = board.clock.now();
  const dispatch = [], findings = [];
  const agents = store.listAgents(board);
  const roadmap = store.roadmap(board);
  const current = roadmap.find(milestone => !milestone.shipped && milestone.items.some(item => item.status !== 'verified'));
  const seats = lineSettings(board)['route.liveOnly'] ? withLocalSeatPresence(board, agents) : agents;
  for (const seat of seats) {
    if (seat.agent_id === 'coordinator' || seat.presence !== 'live' || !fs.exists(join(seat.agent_path, '.git'))) continue;
    let info, skipIds;
    try {
      info = repoInfo(seat.agent_path);
      skipIds = ownSessionReviews(info, board, localSeatSessionDigest(info, seat.agent_id), { listItems: store.listItems });
    } catch (error) {
      if (error instanceof Refused) continue; // An unresolvable local seat cannot take work yet.
      throw error;
    }
    const selected = dispatchWork(board, seat, { policy: config.verify?.policy, familyPolicy: config.verify?.family, skipIds });
    if (!selected.item || selected.held) continue;
    const item = selected.item.item_id;
    if (current && !current.items.some(entry => entry.id === item)) continue;
    const before = previous.find(entry => entry.seat === seat.agent_id && entry.item === item && entry.review === selected.review);
    const lastChange = board.db.prepare("SELECT MAX(event_at) AS at FROM event WHERE (item_id=? AND event_kind IN ('add','claim','release','submit','accept','reject','reopen','refreeze','escalate','withdraw','edit','hold_item','unhold_item','reserve')) OR (event_by=? AND event_kind IN ('claim','reserve','release','submit'))").get(item, seat.agent_id)?.at;
    const lastWork = board.db.prepare("SELECT MAX(event_at) AS at FROM event WHERE event_by=? AND event_kind IN ('claim','reserve','release','submit')").get(seat.agent_id)?.at ?? seat.agent_created_at;
    const idleMinutes = Math.floor(Math.max(0, at.getTime() - Date.parse(lastWork)) / 60000);
    const observedSince = new Date(Math.min(at.getTime(), Date.parse(lastWork))).toISOString();
    const since = before && (!lastChange || lastChange <= before.since) ? before.since : observedSince;
    dispatch.push({ seat: seat.agent_id, item, review: selected.review, since });
    if (at.getTime() - Date.parse(since) < 300000) continue;
    const key = `UNPAIRED_WORK:${seat.agent_id}:${item}`;
    const retained = active.some(finding => finding.key === key && finding.since === since);
    // A delivered warning belongs to the seat's idle spell, even if next later chooses a different item.
    const warned = board.db.prepare(`SELECT 1 FROM event e JOIN shout s ON s.shout_id=json_extract(e.event_detail,'$.shout')
      WHERE e.event_kind='shout' AND e.event_by='sentinel' AND s.shout_to='coordinator'
        AND instr(s.shout_text, ?) = 1 AND instr(s.shout_text, '[UNPAIRED_WORK]') > 0
        AND e.event_id > COALESCE((SELECT MAX(event_id) FROM event WHERE event_by=? AND event_kind IN ('claim','reserve')), 0) LIMIT 1`)
      .get(`Stuck: ${seat.agent_id} beside #`, seat.agent_id);
    if (warned && !retained) continue;
    findings.push({ key, cause: 'UNPAIRED_WORK', item,
      subject: `${seat.agent_id} beside #${item}`, title: 'ready work has waited five minutes for a free seat', since,
      why: `${seat.agent_id} is live and free for ${idleMinutes} min while eligible ${selected.review ? 'review' : 'build'} #${item} remains unreserved`,
      next: `run pullboard next --take in ${seat.agent_path}`, owner: { role: 'coordinator', who: 'coordinator' } });
  }
  return { dispatch, findings };
}
