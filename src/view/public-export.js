/** Fail closed on public snapshot prose; coordinator rulings 064965a1, 919d562b and f15ecdcb [N26]. */
import { Refused } from '../refused.js';

/** The complete public export block list; internal messages are omitted before prose is checked. */
export const PUBLIC_EXPORT_BLOCKS = Object.freeze({
  private: 'private item',
  internal: ['coordinator', 'sentinel', 'person', 'coordinator+person'],
  text: [
    ['machine or host name', /\b192\.168\.\d{1,3}\.\d{1,3}\b|\b[\w-]+\.local\b|\ba5x\b|\bstu\x64io\b|\bmac\x62ook[\w-]*\b|\b[\w.+-]+@[\w.-]+\b/iu],
    ['email', /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+\b/iu],
    ['secret-shaped string', /\b(?:sk-|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{8,}|\b(?:token|secret|password|api[_ -]?key)\s*[:=]\s*["']?\S{8,}|\b[a-f0-9]{32,}\b|(?<![\w/.:])[A-Za-z0-9+/_-]{40,}={0,2}(?![\w/.])/iu],
    ['pricing term', /\$\s*\d[\d,.]*|\bper\s+month\b|\/month\b|\b(?:pricing|price\s+of|subscription\s+price|acquisition|valuation)\b/iu],
  ],
});

/** Decode native JSON detail before checking its prose or internal-message audience. */
function detailOf(value) {
  if (typeof value.event_detail !== 'string') return value.detail ?? {};
  try { return JSON.parse(value.event_detail); }
  catch { throw new Refused('PUBLIC_EXPORT_BLOCKED', 'public export blocked: unreadable event detail', 'repair the event detail before exporting publicly'); }
}

/** Identify the existing internal categories consistently in state, event history and item threads. */
function internalShout(value) {
  const kind = value.event_kind ?? value.kind;
  if (kind === 'decision') return true; // The Needs you projection repeats the internal decision's prose.
  const row = Object.hasOwn(value, 'shout_from');
  if (!row && !['shout', 'shout_news', 'pass', 'answer'].includes(kind)) return false;
  const detail = detailOf(value);
  const from = value.shout_from ?? value.event_by ?? value.by;
  const to = value.shout_to ?? detail.to;
  return Boolean(value.shout_decision ?? detail.decision)
    || PUBLIC_EXPORT_BLOCKS.internal.includes(from) || PUBLIC_EXPORT_BLOCKS.internal.includes(to)
    || typeof from !== 'string' || typeof to !== 'string';
}

/** Exempt only native hexadecimal identifiers in explicitly structured identity fields, never prose. */
function structuredIdentity(field, parent, value) {
  return /^[a-f0-9]{32,128}$/iu.test(value)
    && (parent === 'rowAgesAt' || /(?:id|commit|tree|digest|receipt|sha|hash)$|^(?:board|head|base|trunk|main|acceptedSnapshot)$/iu.test(field));
}

/** Return an independent public document or refuse with categories only, without echoing sensitive values.
 * `privateBoard` comes from the native private_repo_board_id marker, not an item's review sensitivity.
 * @param {any} document
 * @param {{ privateBoard?: boolean }} [options]
 * @returns {any}
 */
export function publicSnapshot(document, { privateBoard = false } = {}) {
  const blocked = new Set(privateBoard ? [PUBLIC_EXPORT_BLOCKS.private] : []);
  /** Traverse every retained API value, including decoded event details and historical thread prose. */
  function visit(value, field = '', parent = '') {
    if (field === 'personRequests') return []; // Phone intent is person-addressed, including its status projection.
    if (Array.isArray(value)) return value.map(entry => visit(entry, field, parent)).filter(entry => entry !== undefined);
    if (value && typeof value === 'object') {
      if (internalShout(value)) return undefined;
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
        key === 'event_detail' ? JSON.stringify(visit(detailOf(value), key, field)) : visit(entry, key, field),
      ]).filter(([, entry]) => entry !== undefined));
    }
    if (typeof value === 'string') {
      for (const [kind, pattern] of PUBLIC_EXPORT_BLOCKS.text) {
        if (kind === 'secret-shaped string' && structuredIdentity(field, parent, value)) continue;
        if (pattern.test(value)) blocked.add(kind);
      }
    }
    return value;
  }
  const result = visit(document);
  if (blocked.size) throw new Refused('PUBLIC_EXPORT_BLOCKED', `public export blocked: ${[...blocked].join(', ')}`, 'remove blocked public text or use a normal local export; do not publish the refused snapshot');
  return result;
}
