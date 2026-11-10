/** Keep routine item updates out of the coordinator's decision channel [C7]. */
import { Refused } from '../../../../packages/kernel/index.js';
import { checkEvidence } from '../../../../packages/store/index.js';

/** Require agent coordinator kinds while preserving person and coordinator messages. */
export function requireCoordinatorShoutPurpose({ from, to, kind }) {
  if (from === 'person' || from === 'coordinator' || to !== 'coordinator') return;
  if (['question', 'blocker', 'decision', 'exception', 'idea'].includes(kind)) return;
  if (kind !== undefined && kind !== 'status') throw new Refused('BAD_MESSAGE_KIND', 'use --kind question, blocker, decision, exception or idea');
  throw new Refused('COORDINATOR_STATUS_FACT',
    'record item progress and results with pullboard fact <id> note "<progress or result>"; to shout the coordinator use --kind question, blocker, decision, exception or idea');
}

const REPORTED = ['submit', 'accept', 'reject', 'merge-only-accept'];
const WINDOW_MS = 10 * 60 * 1000;

/** Recognize validated integration state, with a receipt closing this actor's latest attempt on this item. */
function integrationPurpose(board, from, item, evidence) {
  if (!evidence) return false;
  checkEvidence(board, evidence);
  if (item !== undefined && Number(item) !== evidence.item) return false;
  if (evidence.kind === 'attempt') return evidence.outcome.trim() === 'integrating';
  const previous = board.db.prepare(`SELECT shout_evidence_kind, shout_evidence_outcome FROM shout
    WHERE shout_from = ? AND shout_evidence_item = ?
      AND (shout_evidence_kind = 'receipt' OR (shout_evidence_kind = 'attempt' AND shout_evidence_outcome = 'integrating'))
    ORDER BY shout_id DESC LIMIT 1`).get(from, evidence.item);
  return previous?.shout_evidence_kind === 'attempt' && previous.shout_evidence_outcome === 'integrating';
}

/**
 * Refuse a coordinator shout that only restates a submit or verdict its sender recorded on a named item in the last ten minutes;
 * questions, blockers, decisions and validated integration state are not restatements. A closing receipt
 * requires this actor’s previous integration attempt; plain progress keeps its recorded-event refusal [C7,B22].
 */
export function refuseRestatedReport(board, { from, to, kind, text, item, decision, evidence }, now = Date.now()) {
  if (from === 'person' || from === 'coordinator' || decision || !(to === 'coordinator' || String(to).startsWith('item:'))) return;
  if (['question', 'blocker', 'decision'].includes(kind)) return;
  if (integrationPurpose(board, from, item, evidence)) return;
  const named = new Set([...String(text).matchAll(/#(\d+)/gu)].map((found) => Number(found[1])));
  if (item !== undefined) named.add(Number(item));
  const mine = board.db.prepare(`SELECT event_id, event_at, event_kind FROM event WHERE item_id = ? AND event_by = ? AND event_kind IN (${REPORTED.map(() => '?').join(',')}) ORDER BY event_id DESC LIMIT 1`);
  for (const id of named) {
    const recorded = mine.get(id, from, ...REPORTED);
    if (!recorded || now - Date.parse(recorded.event_at) > WINDOW_MS || now < Date.parse(recorded.event_at)) continue;
    throw new Refused('REPORT_RESTATES_EVENT',
      `#${id} already records your ${recorded.event_kind} (event ${recorded.event_id} at ${recorded.event_at}); the coordinator reads submits and verdicts from the board: pullboard show ${id}. Shout only a question, blocker or decision with --kind.`);
  }
}
