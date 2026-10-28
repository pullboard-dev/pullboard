/** Fail closed on public snapshot prose; coordinator rulings 064965a1, 919d562b, f15ecdcb, 5b1543f9, 8540102d, a9b48855 and 785d4f8d [N26]. */
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
    ['home path', /(?<![\w/:])(?:file:\/\/)?\/(?:Users|home)\/[^/\s"'<>]+(?:\/[^\s"'<>]*)?/iu],
    ['chat or agent session id', /(?<![a-f0-9])[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![a-f0-9])/iu],
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

/** Diagnostics may name only these fixed schema words; dynamic keys and array indexes are redacted. */
const DIAGNOSTIC_FIELDS = new Set(('listing boards state events board root id rowAgesAt items agents shouts asked requests decisions decisionQueue needs personRequests '
  + 'personBars personRows personProposals event_detail detail thread history title criterion brief text note reason check commit tree digest policyCommit '
  + 'criterionDigest receipt frozenDigest submissionProof submissionSize base head review trunk checkBaseline main verdict verdicts verdictState spec practice products releaseNotes '
  + 'source record row rowDecisions specRevisions rigorDrafts sentinelDrafts proofStats ruleCounts config parent signature publicKey agent_id agent_lane model dashboardLanded').split(' '));

/** Name a projection location without echoing arbitrary object keys, identifiers or filesystem names. */
function diagnosticPath(path) {
  return path.map(key => DIAGNOSTIC_FIELDS.has(key) ? key : key === '*' ? '*' : '[field]').join('.');
}

/** Recognize only the native proof-run receipt envelope in the three public event projections. */
function proofReceiptPath(path, eventKind) {
  return eventKind === 'proof-run' && path.at(-1) === 'receipt'
    && ['detail', 'event_detail'].includes(path.at(-2)) && EVENT_PATH.test(path.slice(0, -2).join('/'));
}

/** Exempt exact native paths and formats; free text and arbitrary *_id detail keys never qualify. */
function structuredIdentity(path, value, eventKind) {
  const location = path.join('/');
  let width = 0;
  if (/^(?:listing\/boards\/\*\/id|state\/state\/board|state\/board|events\/board)$/u.test(location)) width = 32;
  if (path.length === 4 && path.slice(0, 3).join('/') === 'state/state/rowAgesAt') width = 40;
  if (/^state\/state\/items\/\*\/(?:commit|merged|verdict\/commit|verdicts\/\*\/commit|checkBaseline\/main)$/u.test(location)) width = 40;
  if (/^state\/state\/dashboardLanded\/\*\/commit$/u.test(location)) return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
  if (/^state\/state\/(?:shouts|asked)\/\*\/shout_evidence_commit$/u.test(location)) width = 40;
  if (EVENT_PATH.test(path.slice(0, -2).join('/')) && ['detail', 'event_detail'].includes(path.at(-2))) {
    width = EVENT_IDENTITIES[eventKind]?.[path.at(-1)] ?? 0;
  }
  if (EVENT_PATH.test(path.slice(0, -3).join('/')) && ['detail', 'event_detail'].includes(path.at(-3))) {
    if (['add', 'edit', 'check-baseline'].includes(eventKind) && path.slice(-2).join('/') === 'checkBaseline/main') width = 40;
    if (['accept', 'reject'].includes(eventKind) && /^review\/(?:commit|head|trunk)$/u.test(path.slice(-2).join('/'))) width = 40;
    if (eventKind === 'submit' && /^submissionSize\/(?:base|head)$/u.test(path.slice(-2).join('/'))) width = 40;
  }
  if (proofReceiptPath(path.slice(0, -1), eventKind)) {
    if (path.at(-1) === 'id') return /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value);
    if (['commit', 'tree'].includes(path.at(-1))) return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
    if (path.at(-1) === 'frozenDigest') width = 64;
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
  const fields = new Set();
  /** Check retained keys as prose; only string values at exact native paths can be structured identities. */
  function inspect(text, path, eventKind, allowIdentity = true) {
    for (const [kind, pattern] of PUBLIC_EXPORT_BLOCKS.text) {
      if (allowIdentity && ['secret-shaped string', 'chat or agent session id'].includes(kind) && structuredIdentity(path, text, eventKind)) continue;
      if (pattern.test(text)) { blocked.add(kind); fields.add(diagnosticPath(path)); }
    }
  }
  /** Traverse every retained API value, including decoded event details and historical thread prose. */
  function visit(value, path = [], eventKind = null) {
    const location = path.join('/');
    if (location === 'state/state/personRequests') return []; // Phone intent is person-addressed, including its status projection.
    if (Array.isArray(value)) return value.map(entry => visit(entry, [...path, '*'], eventKind)).filter(entry => entry !== undefined);
    if (value && typeof value === 'object') {
      if (location === 'state/state/needs/*' && value.kind === 'decision') return undefined;
      if ((EVENT_PATH.test(location) || /^state\/state\/(?:shouts|asked|decisions|decisionQueue|requests)\/\*$/u.test(location)
        || /^state\/state\/items\/\*\/history\/\*$/u.test(location)) && internalShout(value)) return undefined;
      const kind = EVENT_PATH.test(location) ? value.event_kind ?? value.kind : eventKind;
      const entries = location === 'state/state/agents/*'
        ? [['agent_id', value.agent_id], ['agent_lane', value.agent_lane], ['model', value.model ?? value.agent_model]]
        : Object.entries(value).filter(([key]) => !proofReceiptPath(path, kind) || !['parentSession', 'runner'].includes(key));
      return Object.fromEntries(entries.map(([key, entry]) => {
        inspect(key, [...path, key], kind, false);
        return [key, key === 'event_detail' ? JSON.stringify(visit(detailOf(value), [...path, key], kind)) : visit(entry, [...path, key], kind)];
      }).filter(([, entry]) => entry !== undefined));
    }
    if (typeof value === 'string') inspect(value, path, eventKind);
    return value;
  }
  const result = visit(document);
  if (blocked.size) throw new Refused('PUBLIC_EXPORT_BLOCKED', `public export blocked: ${[...blocked].join(', ')}`,
    `${fields.size ? `inspect public fields ${[...fields].slice(0, 8).join(', ')}; ` : ''}remove blocked public text or use a normal local export; do not publish the refused snapshot`);
  return result;
}
