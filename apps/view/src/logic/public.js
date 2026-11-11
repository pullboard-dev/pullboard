/** Fail closed on public snapshot prose; coordinator rulings 064965a1, 919d562b, f15ecdcb, 5b1543f9, 8540102d, a9b48855 and 785d4f8d [N26]. */
import { Refused } from "../../../../packages/kernel/browser.js";

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

/** The facts submit writes about its own machinery (shadow gate, review comparison) are not person-facing; omit them from public views. */
function machineFact(value) {
  if (value.type !== 'fact' && (value.event_kind ?? value.kind) !== 'fact') return false;
  const text = value.text ?? detailOf(value).text;
  return typeof text === 'string' && /^(?:Tier-1 shadow for gate receipt |Review comparison: )/u.test(text);
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
const EVENT_PATH = /^(?:events\/events\/\*|state\/state\/(?:events\/\*|items\/\*\/(?:thread|history)\/\*))$/u;
/** Exact native event fields and their hexadecimal widths; other detail fields remain prose. */
const EVENT_IDENTITIES = Object.freeze({
  claim: { digest: 64, policyRefreshed: 64 }, renew: { digest: 64 },
  submit: { commit: 40, tree: 40, policyCommit: 40, criterionDigest: 64, tooling: 40 },
  accept: { commit: 40, companionDigest: 64 }, reject: { commit: 40, companionDigest: 64, barKey: 64 },
  merged: { commit: 40 }, reopen: { commit: 40 }, refreeze: { before: 64, after: 64 },
  edit: { correctedFrozen: 64, unfrozen: 64 },
});

/** Diagnostics may name only these fixed schema words; dynamic keys and array indexes are redacted. */
const DIAGNOSTIC_FIELDS = new Set(('listing boards state events board root id rowAgesAt items agents shouts asked requests decisions decisionQueue needs personRequests '
  + 'personBars personRows personProposals event_detail detail thread history title criterion brief text note reason check commit tree digest policyCommit '
  + 'criterionDigest receipt frozenDigest submissionProof submissionSize base head review trunk checkBaseline main verdict verdicts verdictState spec practice products releaseNotes '
  + 'source record row rowDecisions specRevisions rigorDrafts sentinelDrafts proofStats ruleCounts config parent signature publicKey agent_id agent_lane model dashboardLanded batch base tip sha merge reviewedCommit candidates invariantEvidence gates submissions diagnostics gateResults proof affectedGate').split(' '));

/** Name a projection location without echoing arbitrary object keys, identifiers or filesystem names. */
function diagnosticPath(path) {
  return path.map(key => DIAGNOSTIC_FIELDS.has(key) ? key : key === '*' ? '*' : '[field]').join('.');
}

/** Recognize only the native proof-run receipt envelope in the three public event projections. */
function proofReceiptPath(path, eventKind) {
  return eventKind === 'proof-run' && path.at(-1) === 'receipt'
    && ['detail', 'event_detail'].includes(path.at(-2)) && EVENT_PATH.test(path.slice(0, -2).join('/'));
}

/**
 * Proof receipt fields that are private execution linkage, never public board content: the session and runner, and a
 * submit reuse's trunk, plan digest and command digest (proof-receipts.js). Only the receipt envelope drops them.
 */
const PRIVATE_RECEIPT_FIELDS = Object.freeze(['parentSession', 'runner', 'main', 'submitReusePlan', 'command']);

/** A landing lease's token is its holder's credential; omit it only from an actual native landing_lease detail. */
function privateLeaseToken(path, key, eventKind) {
  return key === 'token' && eventKind === 'landing_lease' && ['detail', 'event_detail'].includes(path.at(-1))
    && EVENT_PATH.test(path.slice(0, -1).join('/'));
}

/** Omit validated private admission linkage only in its actual native event envelopes. */
function privateAdmissionField(path, key, value, eventKind) {
  if (key !== 'submitAdmission') return false;
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
  if (proofReceiptPath(path, eventKind)) return typeof value === 'string' && uuid.test(value);
  const nativeDetail = ['claim', 'renew'].includes(eventKind) && ['detail', 'event_detail'].includes(path.at(-1))
    && EVENT_PATH.test(path.slice(0, -1).join('/'));
  return nativeDetail && value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 3 && typeof value.id === 'string' && uuid.test(value.id)
    && ['commit', 'tree'].every(field => typeof value[field] === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value[field]));
}

/** Identify one actual native landing-batch payload, never an arbitrary object called batch. */
function nativeBatchPath(path, eventKind) {
  if (eventKind !== 'landing_batch') return null;
  for (let index = 0; index < path.length; index++) {
    if (['detail', 'event_detail'].includes(path[index]) && path[index + 1] === 'batch'
      && EVENT_PATH.test(path.slice(0, index).join('/'))) return path.slice(index + 2);
  }
  return null;
}

/** Private execution linkage is not public board content; the same keys elsewhere remain scanned. */
function privateBatchField(path, key, eventKind) {
  const batch = nativeBatchPath(path, eventKind);
  if (batch === null) return false;
  return batch.length === 0 && ['root', 'owner', 'logPath', 'parallelProofRoot'].includes(key)
    || (batch.join('/') === 'proof' || /^gateResults\/\*$/u.test(batch.join('/'))) && key === 'logPath';
}

/** Exempt exact native paths and formats; free text and arbitrary *_id detail keys never qualify. */
function structuredIdentity(path, value, eventKind) {
  const location = path.join('/');
  const detailField = ['detail', 'event_detail'].includes(path.at(-2)) && EVENT_PATH.test(path.slice(0, -2).join('/'));
  const factId = eventKind === 'fact' && ['id', 'supersedes', 'answers'].includes(path.at(-1))
    && (detailField || /^state\/state\/items\/\*\/thread\/\*$/u.test(path.slice(0, -1).join('/')));
  const batchId = eventKind === 'main-moved' && detailField && path.at(-1) === 'batch'
    || eventKind === 'landing_batch' && path.slice(-2).join('/') === 'batch/id'
      && ['detail', 'event_detail'].includes(path.at(-3)) && EVENT_PATH.test(path.slice(0, -3).join('/'));
  // A fact's ref to its proof-run receipt names the receipt id, the same public identity the receipt carries.
  const factRef = eventKind === 'fact' && path.slice(-2).join('/') === 'ref/id'
    && (['detail', 'event_detail'].includes(path.at(-3)) && EVENT_PATH.test(path.slice(0, -3).join('/'))
      || /^state\/state\/items\/\*\/thread\/\*$/u.test(path.slice(0, -2).join('/')));
  if (factId || batchId || factRef) return /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value);
  if (detailField && eventKind === 'main-moved' && path.at(-1) === 'sha') return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
  const batch = nativeBatchPath(path, eventKind)?.join('/');
  if (batch !== undefined && /^(?:base|tip|supersededByMain|(?:items|candidates|culprits)\/\*\/(?:commit|reviewedCommit|merge|mergeCommit)|conflicts\/\*\/(?:trunk|commit|reviewedCommit)|gateResults\/\*\/tree|proof\/tree|invariantEvidence\/gates\/\*\/commit|invariantEvidence\/gates\/\*\/submissions\/\*\/commit|invariantEvidence\/diagnostics\/\*\/commit)$/u.test(batch)) {
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
  }
  if (batch !== undefined && /^gateResults\/\*\/affectedGate$/u.test(batch)) return /^[a-f0-9]{64}$/u.test(value);
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
      const nativeKind = value.event_kind ?? value.kind;
      if (EVENT_PATH.test(location) && ['usage', 'shared-usage'].includes(nativeKind)) return undefined;
      if (location === 'state/state/needs/*' && value.kind === 'decision') return undefined;
      if (EVENT_PATH.test(location) && machineFact(value)) return undefined;
      if ((EVENT_PATH.test(location) || /^state\/state\/(?:shouts|asked|decisions|decisionQueue|requests)\/\*$/u.test(location)
        || /^state\/state\/items\/\*\/history\/\*$/u.test(location)) && internalShout(value)) return undefined;
      const kind = EVENT_PATH.test(location) ? value.type === 'fact' ? 'fact' : value.event_kind ?? value.kind : eventKind;
      const entries = location === 'state/state/agents/*'
        ? [['agent_id', value.agent_id], ['agent_lane', value.agent_lane], ['model', value.model ?? value.agent_model]]
        : Object.entries(value).filter(([key]) => (!proofReceiptPath(path, kind) || !PRIVATE_RECEIPT_FIELDS.includes(key))
          && !privateBatchField(path, key, kind) && !privateAdmissionField(path, key, value[key], kind) && !privateLeaseToken(path, key, kind));
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
