import { ENGINE_VERSION } from '../../../../state/light.js';
/**
 * A corrected bar records why the old one was wrong [B10,B31,R1].
 *
 * Once an item has ever been claimed, a change to its criterion or check corrects a bar someone
 * built against. Such an edit must say what the old bar got wrong; the reason is stored on the
 * edit event itself, with the fields it changed and, when the item's newest verdict is a reject no
 * earlier correction explained, that reject: the bar caused it, not the build. Nothing else is
 * stored, and nothing in the correction record is taken from the move beyond the reason text, so
 * a relay or API caller cannot mark a reject as the bar's.
 */
import { Refused } from '../../../../kernel/light.js';
import { BAR_ENGINE } from '../../../../state/light.js';

/**
 * True when a sealed edit carries this engine's meaning, a reason; older engines refuse it before replay.
 *
 * @param {string} operation
 * @param {any[]} args
 * @returns {boolean}
 */
export function carriesBarReason(operation, args) {
  return operation === 'editItem' && typeof args?.[1]?.reason === 'string';
}

/** True when any claim, live or long released, has ever been recorded on the item. */
function everClaimed(board, id) {
  return Boolean(board.db.prepare("SELECT 1 FROM event WHERE item_id = ? AND event_kind = 'claim' LIMIT 1").get(id));
}

/** The item's newest verdict when it is a reject no earlier correction already explained, or null. */
function unexplainedReject(board, id) {
  const latest = board.db.prepare('SELECT * FROM verdict WHERE item_id = ? ORDER BY verdict_id DESC LIMIT 1').get(id);
  if (!latest || latest.verdict_decision !== 'REJECT') return null;
  const explained = board.db.prepare("SELECT 1 FROM event WHERE item_id = ? AND event_kind = 'edit' AND json_extract(event_detail, '$.barCorrection.reject.verdict') = ? LIMIT 1").get(id, latest.verdict_id);
  return explained ? null : { verdict: latest.verdict_id, by: latest.verdict_by, reason: latest.verdict_reason, at: latest.verdict_at };
}

/**
 * The edit-event fields for a bar correction, or none; refuses a correction with no reason.
 *
 * @param {any} board
 * @param {any} item the item before the edit
 * @param {any} next its fields after the edit
 * @param {{ reason?: string }} options the move's reason, the only value taken from it
 * @returns {{ reason?: string, barCorrection?: { fields: string[], reject: object | null } }}
 */
export function barCorrectionFields(board, item, next, { reason, widened }) {
  if (widened) return { reason: reason?.trim() || `added test files: ${widened.join(', ')}`, widenedCheck: widened };
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (engine < BAR_ENGINE) return {};
  if (reason !== undefined && typeof reason !== 'string') throw new Refused('USAGE', 'a reason is text: --reason "what the old bar got wrong"');
  const fields = [...(next.item_criterion !== item.item_criterion ? ['criterion'] : []), ...(next.item_check !== item.item_check ? ['check'] : []), ...(next.item_check_timing !== item.item_check_timing ? ['checkTiming'] : [])];
  const text = reason?.trim() ?? '';
  if (!fields.length || !everClaimed(board, item.item_id)) return text ? { reason: text } : {};
  if (!text) {
    throw new Refused('BAR_REASON', `#${item.item_id} has been claimed, so changing its ${fields.join(' and ')} corrects a bar someone built against; say what the old bar got wrong: pullboard edit ${item.item_id} --reason "..."`);
  }
  return { reason: text, barCorrection: { fields, reject: unexplainedReject(board, item.item_id) } };
}

/** The bar corrections in an item's thread, oldest first, each with its reason and the reject it explains. */
export function barCorrections(thread) {
  return thread.filter((entry) => entry.type === 'move' && entry.kind === 'edit' && entry.detail?.barCorrection)
    .map((entry) => ({ at: entry.at, by: entry.by, reason: entry.detail.reason, ...entry.detail.barCorrection }));
}

/** One line for a bar correction as `pullboard show` prints it. */
export function barCorrectionLine(correction, name = (id) => id) {
  return `bar corrected by ${name(correction.by)} (${correction.fields.join(', ')}): ${correction.reason}${correction.reject ? `; the reject by ${name(correction.reject.by)} was caused by the bar` : ''}`;
}

/** One line of bar numbers per author, as `pullboard stats` prints them. */
export function barStatsLines(bars, name = (id) => id) {
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  return Object.entries(bars).map(([agent, counts]) => `bars: ${name(agent)}: ${plural(counts.corrections, 'correction')}, ${plural(counts.barRejects, 'reject')} caused by a bar, ${plural(counts.buildRejects, 'reject')} caused by the build`);
}

/** Read a deterministic value kept by ordered moves; the event history retains its provenance. */
export function readBarState(board, key) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key);
  return row ? JSON.parse(row.meta_value) : null;
}

/** Read the default-off board setting without consulting a replica's local configuration. */
export function barReadySetting(board) { return readBarState(board, 'bar_ready_setting') ?? { enabled: false, since: 0 }; }
