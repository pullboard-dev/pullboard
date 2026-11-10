/** Optional indexed flow-report accounting around the canonical lifecycle reducer [R1,R2]. */
const STAGES = ['ready', 'later', 'build', 'reviewWait', 'review', 'mergeWait', 'rework'];
const BUCKETS = ['under100', '100to300', '300to800', '800plus', 'unknown'];
export const FLOW_REPORT_VERSION = 3;

/** Only lifecycle and recorded policy moves can change report accounting. */
export function reportEvent(event, detail) {
  return ['add', 'edit', 'claim', 'renew', 'submit', 'reserve', 'release', 'accept', 'reject', 'merged', 'reopen', 'refreeze', 'escalate', 'lapse', 'withdraw', 'hold_item', 'unhold_item', 'hold', 'unhold', 'milestone_add', 'milestone_items', 'milestone_moved', 'milestone_placed', 'milestone_edit', 'milestone_remove'].includes(event.event_kind) || event.event_kind === 'line_setting' && detail.key === 'focusMilestone';
}

/** Restore prototype-free maps after JSON decoding so valid names are never inherited keys. */
export function safeReportPolicy(policy) {
  for (const key of ['memberships', 'dependents', 'lanes', 'members', 'open']) {
    if (Object.getPrototypeOf(policy[key]) !== null) policy[key] = Object.assign(Object.create(null), policy[key]);
  }
  if (policy.membershipVersion !== 2) {
    for (const [id, names] of Object.entries(policy.memberships)) {
      if (!Array.isArray(names)) policy.memberships[id] = [names];
    }
    policy.membershipVersion = 2;
  }
  return policy;
}

/** Start policy facts reconstructed only from recorded events. */
export function newReportPolicy() { return safeReportPolicy({ membershipVersion: 2, focus: null, memberships: {}, heldLanes: [], verified: [], dependents: {}, lanes: {}, members: {}, open: {} }); }

/** Allocate accounting without manufacturing an absent historical start. */
function reportState() { return { totals: Object.fromEntries(STAGES.map(key => [key, 0])), known: false, missing: [], submissions: 0, first: null, deps: [], held: false }; }

/** Keep nested report facts immutable in the reusable prepared snapshot. */
export function frozenReport(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozenReport(child);
    Object.freeze(value);
  }
  return value;
}

/** Classify an observed canonical state; focus affects reporting, never claim authority. */
function stage(item, policy, at) {
  const report = item.report;
  if (!report.known || ['merged', 'withdrawn'].includes(item.state)) return null;
  if (item.state === 'claimed') return Number.isFinite(item.leaseUntil) && item.leaseUntil <= at ? 'rework' : 'build';
  if (item.state === 'submitted') return item.reserve && (!Number.isFinite(item.reserve.until) || item.reserve.until > at) ? 'review' : 'reviewWait';
  if (item.state === 'accepted') return 'mergeWait';
  if (item.state !== 'open') return null;
  if (report.returned) return 'rework';
  const milestones = policy.memberships[item.id] ?? [];
  return report.held || policy.heldLanes.includes(item.lane) || report.deps.some(id => !policy.verified.includes(id)) ||
    policy.focus && !milestones.includes(policy.focus) ? 'later' : 'ready';
}

/** Charge elapsed time, splitting recorded reservation and claim expiry boundaries exactly. */
export function advanceReport(item, policy, at, windows) {
  item.report ??= reportState();
  const report = item.report;
  if (windows && !report.windows) report.windows = windows.map(bounds => ({ ...bounds,
    milliseconds: Object.fromEntries(STAGES.map(key => [key, 0])), unknownMilliseconds: 0 }));
  if (!Number.isFinite(report.at)) { report.at = at; return; }
  const boundaries = [item.leaseUntil, item.reserve?.until].filter(value => Number.isFinite(value) && value > report.at && value < at).sort((a, b) => a - b);
  for (const end of [...boundaries, at]) {
    const key = stage(item, policy, report.at);
    if (key && end >= report.at) report.totals[key] += (end - report.at) / 60_000;
    for (const rangeTotals of report.windows ?? []) {
      const elapsed = Math.max(0, Math.min(end, rangeTotals.end) - Math.max(report.at, rangeTotals.start));
      if (key) rangeTotals.milliseconds[key] += elapsed;
      else if (!['merged', 'withdrawn'].includes(item.state)) rangeTotals.unknownMilliseconds += elapsed;
    }
    report.at = end;
  }
}

/** Clip optional comparison observations through the same canonical stage classifier, never another lifecycle. */
export function projectReportWindows(items, policy, now, windows) {
  const observedPolicy = safeReportPolicy(structuredClone(policy));
  const rows = items.map(item => {
    const copy = structuredClone(item);
    advanceReport(copy, observedPolicy, now, windows);
    return copy;
  });
  return windows.map((bounds, index) => ({ ...bounds,
    milliseconds: Object.fromEntries(STAGES.map(key => [key,
      rows.reduce((sum, row) => sum + (row.report.windows?.[index].milliseconds[key] ?? 0), 0)])),
    unknownMilliseconds: rows.reduce((sum, row) => sum + (row.report.windows?.[index].unknownMilliseconds ?? 0), 0) }));
}

/** Preserve missing lifecycle boundaries before the canonical transition replaces them. */
export function prepareReportMove(item, event, detail) {
  const report = item.report;
  if (item.state === 'claimed' && Number.isFinite(item.leaseUntil) && item.leaseUntil <= Date.parse(event.event_at)) report.returned = true;
  report.matchingDecision = ['accept', 'reject'].includes(event.event_kind) && item.state === 'submitted' && detail.commit === item.commit;
  if (event.event_kind === 'submit' && item.state !== 'claimed') report.missing.push('build');
  if (['accept', 'reject'].includes(event.event_kind) && detail.commit === item.commit && item.state === 'submitted') {
    if (!item.reserve || Number.isFinite(item.reserve.until) && item.reserve.until < Date.parse(event.event_at)) report.missing.push('review');
  }
  if (event.event_kind === 'merged' && item.state !== 'accepted' && !Number.isFinite(item.mergeAt)) report.missing.push('mergeWait');
}

/** Observe metadata alongside, rather than replacing, the existing lifecycle transition. */
export function recordReport(item, event, detail) {
  const report = item.report;
  if (event.event_kind === 'add') { report.known = true; report.deps = detail.after ?? []; }
  if (event.event_kind === 'edit' && Array.isArray(detail.after)) report.deps = detail.after;
  if (event.event_kind === 'hold_item') report.held = true;
  if (event.event_kind === 'unhold_item') report.held = false;
  if (event.event_kind === 'claim') report.returned = false;
  if (['reject', 'reopen', 'refreeze', 'escalate', 'lapse'].includes(event.event_kind) && !(event.event_kind === 'refreeze' && detail.retainedClaim) || event.event_kind === 'release' && !detail.review && item.state === 'open') report.returned = true;
  if (event.event_kind === 'submit') {
    if (!Number.isFinite(item.claimAt)) report.missing.push('build');
    report.submissions += 1;
    const size = detail.submissionSize;
    const validSize = size?.method === 'added-plus-deleted-no-renames' && size.head === detail.commit &&
      /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(size.base ?? '') && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(size.head ?? '') && Number.isSafeInteger(size.lines) && size.lines >= 0;
    report.first ??= { commit: detail.commit, size: validSize ? size.lines : null, verdict: null };
  }
  if (report.matchingDecision && report.first?.commit === detail.commit && report.first.verdict === null) report.first.verdict = event.event_kind;
}

/** Select only shards whose open interval classification changes with this policy event. */
export function affectedReportItems(policy, event, detail) {
  safeReportPolicy(policy);
  const kind = event.event_kind;
  if (kind === 'refreeze' && detail.retainedClaim) return [];
  let ids = [];
  if (['accept', 'reject', 'merged', 'reopen', 'refreeze', 'escalate', 'lapse'].includes(kind)) ids = policy.dependents[event.item_id] ?? [];
  else if (['hold', 'unhold'].includes(kind)) ids = policy.lanes[detail.lane] ?? [];
  else if (kind === 'line_setting' && detail.key === 'focusMilestone') ids = Object.keys(policy.open).map(Number);
  else if (kind === 'milestone_add') ids = detail.items ?? [];
  else if (kind === 'milestone_items') ids = [...(detail.add ?? []), ...(detail.remove ?? [])];
  else if (['milestone_moved', 'milestone_placed'].includes(kind)) ids = [event.item_id];
  else if (['milestone_edit', 'milestone_remove'].includes(kind)) ids = policy.members[detail.before ?? detail.name] ?? [];
  return [...new Set(ids)].filter(id => policy.open[id]);
}

/** Maintain reverse dependency and grouping indexes only for the changed item. */
export function indexReportItem(policy, item) {
  safeReportPolicy(policy);
  const report = item.report;
  const changedDeps = JSON.stringify(report.indexedDeps) !== JSON.stringify(report.deps);
  for (const id of changedDeps ? report.indexedDeps ?? [] : []) policy.dependents[id] = (policy.dependents[id] ?? []).filter(value => value !== item.id);
  for (const id of changedDeps ? report.deps : []) {
    policy.dependents[id] ??= [];
    if (!policy.dependents[id].includes(item.id)) policy.dependents[id].push(item.id);
  }
  report.indexedDeps = [...report.deps];
  if (report.indexedLane !== item.lane) {
    if (report.indexedLane) policy.lanes[report.indexedLane] = (policy.lanes[report.indexedLane] ?? []).filter(id => id !== item.id);
    policy.lanes[item.lane] ??= [];
    if (!policy.lanes[item.lane].includes(item.id)) policy.lanes[item.lane].push(item.id);
    report.indexedLane = item.lane;
  }
  if (item.state === 'open') policy.open[item.id] = true;
  else delete policy.open[item.id];
}

/** Update historical reporting policy after old intervals have been charged. */
export function recordReportPolicy(policy, event, detail, item) {
  safeReportPolicy(policy);
  const kind = event.event_kind;
  if (kind === 'line_setting' && detail.key === 'focusMilestone') policy.focus = (typeof detail.value === 'object' && detail.value !== null ? detail.value.name : detail.value) || null;
  if (kind === 'hold' && !policy.heldLanes.includes(detail.lane)) policy.heldLanes.push(detail.lane);
  if (kind === 'unhold') policy.heldLanes = policy.heldLanes.filter(lane => lane !== detail.lane);
  const matching = item?.commit && item.commit === detail.commit;
  if (kind === 'accept' && matching || kind === 'merged') { if (!policy.verified.includes(event.item_id)) policy.verified.push(event.item_id); }
  if (kind === 'reject' && matching || ['reopen', 'refreeze', 'escalate', 'lapse'].includes(kind) && !(kind === 'refreeze' && detail.retainedClaim)) policy.verified = policy.verified.filter(id => id !== event.item_id);
  if (kind === 'milestone_add') for (const id of detail.items ?? []) addMembership(policy, id, detail.name);
  if (kind === 'milestone_items') {
    for (const id of detail.add ?? []) addMembership(policy, id, detail.name);
    for (const id of detail.remove ?? []) removeMembership(policy, id, detail.name);
  }
  if (kind === 'milestone_moved') {
    removeMembership(policy, event.item_id, detail.from);
    addMembership(policy, event.item_id, detail.to);
  }
  if (kind === 'milestone_placed' && !String(detail.note ?? '').startsWith('ordered in ')) {
    // Placement and move overrides replace the board's prior assignments. A rank-only
    // override emits the same event kind but leaves memberships intact.
    for (const name of [...(policy.memberships[event.item_id] ?? [])]) removeMembership(policy, event.item_id, name);
    if (typeof detail.milestone === 'string' && detail.milestone) addMembership(policy, event.item_id, detail.milestone);
  }
  if (kind === 'milestone_edit' && detail.before !== detail.after) {
    for (const id of [...(policy.members[detail.before] ?? [])]) {
      const names = policy.memberships[id].map(name => name === detail.before ? detail.after : name);
      removeMembership(policy, id, detail.before);
      policy.memberships[id] = names;
      policy.members[detail.after] ??= [];
      if (!policy.members[detail.after].includes(id)) policy.members[detail.after].push(id);
    }
  }
  if (kind === 'milestone_remove') for (const id of [...(policy.members[detail.name] ?? [])]) removeMembership(policy, id, detail.name);
}

/** Append a real membership without losing other milestones or duplicating reverse indexes. */
function addMembership(policy, id, name) {
  const names = policy.memberships[id] ??= [];
  if (!names.includes(name)) names.push(name);
  policy.members[name] ??= [];
  if (!policy.members[name].includes(id)) policy.members[name].push(id);
}

/** Remove only the named membership; shipping one milestone retains all unrelated memberships. */
function removeMembership(policy, id, name) {
  const names = (policy.memberships[id] ?? []).filter(value => value !== name);
  if (names.length) policy.memberships[id] = names;
  else delete policy.memberships[id];
  if (policy.members[name]) {
    policy.members[name] = policy.members[name].filter(value => value !== id);
    if (!policy.members[name].length) delete policy.members[name];
  }
}

/** Summarize known first decisions without assigning unknown history a zero rate. */
function decisions(rows) {
  const accepted = rows.filter(row => row.report.known && row.report.first?.verdict === 'accept').length;
  const decided = rows.filter(row => row.report.known && ['accept', 'reject'].includes(row.report.first?.verdict)).length;
  return { accepted, decided, rate: decided ? accepted / decided : null, unknown: rows.length - decided };
}

/** Assign exact half-open size buckets from the first captured submission only. */
function bucket(item) {
  const size = item.report.first?.size;
  return !Number.isSafeInteger(size) || size < 0 ? 'unknown' : size < 100 ? 'under100' : size < 300 ? '100to300' : size < 800 ? '300to800' : '800plus';
}

/** Aggregate measured durations and retain a separate count of incomplete histories. */
function aggregate(rows, item = false) {
  const landed = rows.filter(row => row.state === 'merged');
  const stages = Object.fromEntries(STAGES.map(key => {
    const measured = rows.filter(row => row.report.known && !row.report.missing.includes(key));
    return [key, { minutes: item && !measured.length ? null : measured.reduce((sum, row) => sum + row.report.totals[key], 0), unknown: rows.length - measured.length }];
  }));
  return { stages, firstTry: decisions(rows), submissionsPerLanded: !landed.length || landed.some(row => !row.report.known || !row.report.first) ? null : landed.reduce((sum, row) => sum + row.report.submissions, 0) / landed.length,
    sizeBuckets: Object.fromEntries(BUCKETS.map(key => [key, decisions(rows.filter(row => bucket(row) === key))])) };
}

/** Project copies of indexed facts at the observation clock, never mutating durable shards. */
export function projectReport(items, policy, now) {
  if (!policy) return { available: false };
  policy = safeReportPolicy(structuredClone(policy));
  const rows = items.map(item => { const copy = structuredClone(item); advanceReport(copy, policy, now); return copy; });
  /** Group recorded item lanes without consulting current mutable rows. */
  function groups(key, value) {
    return [...new Set(rows.map(value))].sort().map(name => ({ [key]: name, ...aggregate(rows.filter(row => value(row) === name)) }));
  }
  const milestoneNames = [...new Set(rows.flatMap(row => policy.memberships[row.id] ?? [null]))].sort();
  return { scope: 'all-time', items: rows.map(row => ({ id: row.id, lane: row.lane,
    milestone: policy.memberships[row.id]?.at(-1) ?? null, milestones: [...(policy.memberships[row.id] ?? [])], ...aggregate([row], true) })),
    lanes: groups('lane', row => row.lane),
    milestones: milestoneNames.map(name => ({ milestone: name, ...aggregate(rows.filter(row => name === null
      ? !policy.memberships[row.id]?.length : policy.memberships[row.id]?.includes(name))) })),
    overall: aggregate(rows) };
}
