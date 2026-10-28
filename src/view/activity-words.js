/** Plain words for automatic board notices, shared by the view's Activity and sentinel panels [N26].
 * The page embeds this function, so it reads only its arguments and language globals.
 */
export function activityWords(finding, { now = Date.now(), clock = value => new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) } = {}) {
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
  const localTimes = text => String(text ?? '').replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\b/gu,
    value => Number.isFinite(Date.parse(value)) ? clock(value) : value);
  const plain = text => localTimes(text).replace(/\[([A-Z][A-Z0-9_]+)\]/gu, (_, key) => words[key] ?? key.toLowerCase().replaceAll('_', ' '));
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
  return { text: plain(text), next: plain(finding.next), since: Number.isFinite(Date.parse(finding.since)) ? clock(finding.since) : '', label: words[code] ?? code.toLowerCase().replaceAll('_', ' ') };
}
