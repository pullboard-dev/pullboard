/** Fail closed on public snapshot prose; coordinator rulings 064965a1, 919d562b and f15ecdcb [N26]. */
import { Refused } from '../refused.js';

/** The complete public export block list; internal messages are omitted before prose is checked. */
export const PUBLIC_EXPORT_BLOCKS = Object.freeze({
  private: 'private item',
  unreadable: 'unreadable event detail',
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
  catch { throw new Refused('PUBLIC_EXPORT_BLOCKED', `public export blocked: ${PUBLIC_EXPORT_BLOCKS.unreadable}`, 'repair the event detail before exporting publicly'); }
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

/** Native event locations in the three exported API documents, not arbitrary JSON objects. */
const EVENT_PATH = /^(?:events\/events\/\*|state\/state\/(?:events\/\*|items\/\*\/thread\/\*))$/u;
/** Exact native event fields and their hexadecimal widths; other detail fields remain prose. */
const EVENT_IDENTITIES = Object.freeze({
  claim: { digest: 64 }, renew: { digest: 64 },
  submit: { commit: 40, tree: 40, policyCommit: 40, criterionDigest: 64 },
  accept: { commit: 40, companionDigest: 64 }, reject: { commit: 40, companionDigest: 64 },
  merged: { commit: 40 }, reopen: { commit: 40 }, refreeze: { before: 64, after: 64 },
  edit: { correctedFrozen: 64, unfrozen: 64 },
});

/** Exempt exact native paths and formats; free text and arbitrary *_id detail keys never qualify. */
function structuredIdentity(path, value, eventKind) {
  const location = path.join('/');
  let width = 0;
  if (/^(?:listing\/boards\/\*\/id|state\/state\/board|state\/board|events\/board)$/u.test(location)) width = 32;
  if (path.length === 4 && path.slice(0, 3).join('/') === 'state/state/rowAgesAt') width = 40;
  if (/^state\/state\/items\/\*\/(?:commit|merged|verdict\/commit|verdicts\/\*\/commit|checkBaseline\/main)$/u.test(location)) width = 40;
  if (/^state\/state\/(?:shouts|asked)\/\*\/shout_evidence_commit$/u.test(location)) width = 40;
  if (EVENT_PATH.test(path.slice(0, -2).join('/')) && ['detail', 'event_detail'].includes(path.at(-2))) {
    width = EVENT_IDENTITIES[eventKind]?.[path.at(-1)] ?? 0;
  }
  if (EVENT_PATH.test(path.slice(0, -3).join('/')) && ['detail', 'event_detail'].includes(path.at(-3))) {
    if (['add', 'edit', 'check-baseline'].includes(eventKind) && path.slice(-2).join('/') === 'checkBaseline/main') width = 40;
    if (['accept', 'reject'].includes(eventKind) && /^review\/(?:commit|head|trunk)$/u.test(path.slice(-2).join('/'))) width = 40;
  }
  return width > 0 && new RegExp(`^[a-f0-9]{${width}}$`, 'u').test(value);
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
  function visit(value, path = [], eventKind = null) {
    const field = path.at(-1);
    if (field === 'personRequests') return []; // Phone intent is person-addressed, including its status projection.
    if (Array.isArray(value)) return value.map(entry => visit(entry, [...path, '*'], eventKind)).filter(entry => entry !== undefined);
    if (value && typeof value === 'object') {
      if (internalShout(value)) return undefined;
      const kind = EVENT_PATH.test(path.join('/')) ? value.event_kind ?? value.kind : eventKind;
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
        key === 'event_detail' ? JSON.stringify(visit(detailOf(value), [...path, key], kind)) : visit(entry, [...path, key], kind),
      ]).filter(([, entry]) => entry !== undefined));
    }
    if (typeof value === 'string') {
      for (const [kind, pattern] of PUBLIC_EXPORT_BLOCKS.text) {
        if (kind === 'secret-shaped string' && structuredIdentity(path, value, eventKind)) continue;
        if (pattern.test(value)) blocked.add(kind);
      }
    }
    return value;
  }
  const result = visit(document);
  if (blocked.size) throw new Refused('PUBLIC_EXPORT_BLOCKED', `public export blocked: ${[...blocked].join(', ')}`, 'remove blocked public text or use a normal local export; do not publish the refused snapshot');
  return result;
}
