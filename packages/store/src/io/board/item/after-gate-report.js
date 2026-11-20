/** The notes the after-gate flow leaves: a dependent's claim, the minutes a parent's verify saved its dependents, and each dependent sent back for a rebuild [C7,#12325,#12326]. */
import { appendFact } from '../fact.js';

/**
 * Record one note fact on a dependent whose claim took a gate-green after-gate parent, so the thread shows what the build started from.
 * Why a note through appendFact with no engine gate: replay of an older board is unchanged, and a dependent with no after-gate parent records nothing.
 *
 * @param {any} board The open board, inside the claim.
 * @param {number} id The dependent that was claimed.
 * @param {{ parent: number, head: string, agentId: string }} record The after-gate base the claim recorded and the claiming seat.
 * @returns {object} The fact written.
 */
export function recordAfterGateClaim(board, id, { parent, head, agentId }) {
  const at = board.clock.now().toISOString();
  return appendFact(board, id, { agentId, kind: 'note', text: `after-gate claim: parent #${parent} at head ${head}, claimed ${at}` });
}

/** The claim time a dependent's after-gate claim note records for this parent, as milliseconds, or null when it recorded none. */
function claimedAt(board, id, parent) {
  const prefix = `after-gate claim: parent #${parent} at head `;
  for (const row of board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='fact' ORDER BY event_id").all(id)) {
    let text;
    try { text = JSON.parse(row.event_detail)?.text; } catch { continue; }
    if (typeof text !== 'string' || !text.startsWith(prefix)) continue;
    const at = Date.parse(text.slice(text.lastIndexOf(', claimed ') + ', claimed '.length));
    if (Number.isFinite(at)) return at;
  }
  return null;
}

/**
 * Record one note on a verified after-gate parent naming each dependent that claimed it after its gate went green and the whole minutes from that claim to this verify.
 * Why: the minutes a dependent built while the parent waited in review are what the after-gate flow saves, and the thread is where the person reads them.
 *
 * @param {any} board The open board, inside the verify.
 * @param {number} parent The verified parent.
 * @param {number[]} dependents The ids whose after-gate list names the parent.
 * @param {{ agentId: string }} by The verifying seat.
 * @returns {object | null} The fact written, or null when no dependent claimed on the gate.
 */
export function recordAfterGateSaved(board, parent, dependents, { agentId }) {
  const now = board.clock.now().getTime();
  const saved = dependents.flatMap(id => {
    const at = claimedAt(board, id, parent);
    return at === null ? [] : [`#${id} ${Math.max(0, Math.floor((now - at) / 60_000))} min`];
  });
  return saved.length ? appendFact(board, parent, { agentId, kind: 'note', text: `after-gate saved: ${saved.join(', ')}` }) : null;
}

/**
 * Record one note on a parent naming a dependent its rejection or new head sent back, so the parent's thread shows what was rebuilt.
 *
 * @param {any} board The open board, inside the send-back.
 * @param {number} parent The parent that was rejected or resubmitted.
 * @param {number} dependent The dependent sent back.
 * @param {{ agentId?: string }} [by] The recording agent; the coordinator when omitted.
 * @returns {object} The fact written.
 */
export function recordAfterGateRebuild(board, parent, dependent, { agentId = 'coordinator' } = {}) {
  return appendFact(board, parent, { agentId, kind: 'note', text: `after-gate rebuild: #${dependent} goes back and is rebuilt` });
}
