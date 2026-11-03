/** Plain words for automatic board notices, shared by the view's Activity and sentinel panels [N26].
 * The page embeds this function, so it reads only its arguments and language globals.
 */
export function activityWords(finding, { now, timestampLabels = new Map(), preserveWords = false } = {}) {
  const code = String(finding.cause ?? '').replace(/^refusal:/u, '');
  const words = {
    RANK_INVERSION: 'holds lower-priority work while higher-priority work sits free',
    IDLE_AGENT: 'has been idle while work waits in its lane',
    AFTER_WITHDRAWN: 'waits on withdrawn work', UNPAIRED_WORK: 'has work waiting for a builder',
    CLAIM_LAPSED: 'has a building lease that ran out', REVIEW_LAPSED: 'has a review reservation that ran out',
    NO_REVIEWER: 'is waiting for a reviewer', REWORK_UNCLAIMED: 'needs a builder after being sent back',
    REWORK_DEFERRED: 'has rework planned for a later release', HOLD_STALE: 'has a hold that needs attention',
    HOLD_CLEARS: 'has a hold that can now clear', CONFLICT_HOLD_CLEARS: 'has a conflict hold that can now clear', ITEM_UNTAKEABLE: 'has no available agent who can take it',
    ROUTE_WORK_SHORTAGE: 'needs more free work for its idle agents', ROUTE_UNSERVED: 'has work without an active agent',
    UNLANDED_CONFLICT: 'passed review but conflicts with the trunk', UNLANDED_STACKED: 'carries work that has not passed review',
    UNLANDED_WAITING: 'passed review and waits for its dependencies to land', UNLANDED_READY: 'passed review and is ready to land',
    UNLANDED_HELD: 'passed review and is held', RELEASE_OVERDUE: 'has landed work waiting for a release',
    RELAY_CANARY: 'has a degraded connection', STALE_ROW_DECISION: 'has a person decision that needs refreshing',
    AGENT_CPU: 'is using more CPU than its budget', UNANSWERED: 'is waiting for an answer',
  };
  const events = {
    add: 'added work', claim: 'started building', release: 'let go of the work', renew: 'continued building',
    resume: 'resumed the work', reserve: 'started reviewing', submit: 'submitted for review', 'submit-merge': 'updated submitted work',
    accept: 'passed the work', reject: 'sent the work back', reopen: 'reopened the work', merged: 'landed the work', 'main-moved': 'moved main',
    withdraw: 'withdrew the work', patch: 'updated the work', edit: 'edited the work',
    rehomeImport: 'brought in the work', intake: 'received the work', lapse: 'released an expired lease',
    fact: 'recorded evidence', note: 'added a note', measurement: 'recorded a measurement',
    capture: 'recorded an observation', diff: 'recorded a source comparison', decision: 'recorded a decision',
    rejection: 'recorded a rejection', supersession: 'replaced earlier evidence', 'root-cause': 'recorded the cause',
    'bar-check': 'checked the criterion', 'bar-answer': 'answered a criterion question',
    'proof-run': 'ran the proof', 'health-failure': 'reported a health finding',
    'health-resolved': 'resolved a health finding', 'health-scan': 'checked the board',
    refreeze: 'refroze the criterion', escalate: 'requested stronger review', hold: 'held the work', unhold: 'lifted the hold', register: 'joined the board',
    shout: 'sent a message', shout_news: 'sent a message', answer: 'answered a question',
  };
  const localTimes = text => String(text ?? '').replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\b/gu,
    value => Number.isFinite(Date.parse(value)) ? timestampLabels.get(value) ?? value : value);
  const reasons = { TEST_FAILURE: 'Tests failed', BEHAVIOR_MISMATCH: 'Behavior did not match',
    INSUFFICIENT_EVIDENCE: 'Not enough evidence', STALE_HEAD: 'Source changed', OTHER: 'Other reason' };
  /** Localize machine labels while preserving the reviewer's own note after its typed rejection prefix. */
  const plain = text => {
    const localized = localTimes(text);
    if (preserveWords) return localized;
    const quoted = /^(rejected by \S+ \([A-Z][A-Z0-9_]+\): )([\s\S]*)$/u.exec(localized);
    const machine = quoted ? quoted[1] : localized;
    const described = machine.replace(/\[([A-Z][A-Z0-9_]+)\]/gu, (_, key) => words[key] ?? reasons[key] ?? key.toLowerCase().replaceAll('_', ' '))
      .replace(/\(([A-Z][A-Z0-9_]+)\)/gu, (_, key) => '(' + (reasons[key] ?? words[key] ?? key.toLowerCase().replaceAll('_', ' ')) + ')')
      .replace(/\b(TEST_FAILURE|BEHAVIOR_MISMATCH|INSUFFICIENT_EVIDENCE|STALE_HEAD|OTHER)\b/gu, key => reasons[key]);
    return described + (quoted ? quoted[2] : '');
  };
  let text = finding.why || [finding.subject, words[code] ?? code.toLowerCase().replaceAll('_', ' ')].filter(Boolean).join(' ');
  if (code === 'RANK_INVERSION') {
    const match = /^(.*?) claimed (#\d+) while (#\d+) ranks ahead.*and sits free/u.exec(text);
    if (match) text = `${match[1]} holds ${match[2]} while ${match[3]} ranks above it and sits free`;
  }
  if (code === 'IDLE_AGENT') {
    const waiting = /while (#\d+) waits in ([\w-]+)/u.exec(text);
    const minutes = Math.max(0, Math.floor((now - Date.parse(finding.since)) / 60_000));
    if (waiting && Number.isFinite(minutes)) text = `${finding.owner || finding.subject} has been idle for ${minutes} minutes while ${waiting[1]} waits in its ${waiting[2]} lane`;
  }
  return { text: plain(text), next: plain(finding.next), since: Number.isFinite(Date.parse(finding.since)) ? timestampLabels.get(finding.since) ?? finding.since : '', label: finding.kind ? (events[finding.kind] ?? 'recorded an update') : (reasons[code] ?? words[code] ?? code.toLowerCase().replaceAll('_', ' ')) };
}
