/** Incremental capacity observations share the canonical lifecycle, never a second raw-history replay [R1,R2]. */
import { moveFlowItem } from '../flow.js';

export const CAPACITY_VERSION = 2;
const HOUR = 3_600_000;
const RETURNS = new Set(['reopen', 'refreeze', 'escalate', 'lapse']);

/** Empty history is distinguishable from an incompatible or partly rebuilt observer. */
export function emptyCapacityCounter() {
  return { version: CAPACITY_VERSION, last: 0, invalid: false, heldLanes: [] };
}

/** Preserve absent or reversed boundaries as unknown hours, including genuinely observed zero. */
function hours(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / HOUR : null;
}

/** Validate captured size provenance rather than measuring today's mutable checkout. */
function submissionSize(detail) {
  const size = detail.submissionSize;
  return size?.method === 'added-plus-deleted-no-renames' && size.head === detail.commit
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(size.base ?? '')
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(size.head ?? '')
    && Number.isSafeInteger(size.lines) && size.lines >= 0 ? size.lines : null;
}

/** Classify only recorded return causes, without parsing a refusal's human wording. */
function returnKind(kind, detail) {
  if (kind === 'reject') return 'reject';
  if (kind === 'release') return 'release';
  if (kind === 'reopen' && detail.conflict) return 'conflict';
  if (kind === 'reopen' && detail.landingFailure) return 'landing-test';
  // A coordinator reopen after accept, typed by category (verdict stale: a file changed on main).
  if (kind === 'reopen' && detail.causeDerivation?.kind === 'reopen-category') return 'stale';
  return 'unknown';
}

/** Allocate a small item shard without filling missing historical metadata from current rows. */
function newItem(id) {
  return { id, lane: 'unknown', route: null, after: null, files: null, held: null,
    historyKnown: false, claimCount: 0, cycleStart: null, cycleRecorded: false,
    attempt: 'unknown', buildFrom: null, buildBy: null, buildRoute: null,
    returnedAt: null, returnKind: null, submission: null };
}

/** Append one typed measurement under a deterministic event/day key. */
function sample(event, at, kind, fields, write) {
  const iso = new Date(at).toISOString();
  write(`capacity-sample:${iso.slice(0, 10)}:${event.event_id}:${kind}`, {
    at: iso, kind, route: null, size: null, attempt: 'unknown', hours: null, ...fields,
  });
}

/** Record the first successful local terminal batch, not an item's prior acceptance queue wait. */
function landingSample(event, detail, at, read, write) {
  const batch = detail.batch;
  if (!batch || typeof batch.id !== 'string' || !batch.id || !['trunk', 'landed'].includes(batch.state)) return;
  const key = `capacity-batch:${batch.id}`;
  if (read(key)?.terminal) return;
  const ids = Array.isArray(batch.items) ? [...new Set(batch.items.map(item => item?.id)
    .filter(id => Number.isSafeInteger(id) && id > 0))] : [];
  const start = Date.parse(batch.startedAt);
  const end = Date.parse(batch.updatedAt);
  const duration = hours(start, end);
  sample(event, at, 'landing', { hours: duration, batchSize: ids.length || null, failed: 0,
    batchId: batch.id, basis: 'coordinator-batch-cycle', censored: true }, write);
  write(key, { terminal: true, event: event.event_id, state: batch.state,
    startedAt: Number.isFinite(start) ? batch.startedAt : null,
    updatedAt: Number.isFinite(end) ? batch.updatedAt : null,
    members: ids, hours: duration, basis: 'coordinator-batch-cycle', censored: true });
}

/** Complete one accepted source-head episode independently of any coordinator batch timing. */
function landingOutcome(event, detail, at, item, before, write) {
  const episode = item.landingEpisode;
  if (!episode || before.state !== 'accepted' || before.commit !== episode.commit) return;
  const merged = event.event_kind === 'merged';
  const returned = RETURNS.has(event.event_kind) && !(event.event_kind === 'refreeze' && detail.retainedClaim)
    || event.event_kind === 'withdraw';
  if (!merged && !returned) return;
  // A merged receipt names the landed SHA; a typed return must name the accepted source SHA.
  const matchingReturn = event.event_kind === 'reopen' && detail.commit === episode.commit;
  const cause = merged ? 'merged' : matchingReturn ? returnKind(event.event_kind, detail) : 'unknown';
  sample(event, at, 'landingOutcome', { item: event.item_id, route: episode.route,
    sourceCommit: episode.commit, acceptEvent: episode.acceptEvent,
    failed: merged ? false : ['conflict', 'landing-test', 'stale'].includes(cause) ? true : null,
    cause, size: episode.size }, write);
  item.landingEpisode = null;
}

/** Index only native ordered approval authority, never an arbitrary mutable metadata row. */
function approvalEvent(event, detail, read, write) {
  const baseline = event.event_kind === 'spec_approval_baseline' && event.event_by === 'coordinator';
  const decision = event.event_kind === 'row_decision' && event.event_by === 'person'
    && detail.record?.kind === 'spec' && ['approve', 'decline'].includes(detail.record.decision);
  if (!baseline && !decision) return;
  const prior = read('capacity-approvals');
  const rows = Object.assign(Object.create(null), prior?.rows ?? {});
  if (baseline) for (const row of Array.isArray(detail.rows) ? detail.rows : []) {
    if (typeof row.id === 'string' && !Object.hasOwn(rows, row.id)) rows[row.id] = true;
  }
  if (decision && typeof detail.record.id === 'string') rows[detail.record.id] = detail.record.decision === 'approve';
  write('capacity-approvals', { rows });
}

/** Fold one ordered event into independent shards; the caller supplies atomic cache persistence. */
export function appendCapacityCounter(event, detail, at, read, write) {
  const summary = read('capacity-summary') ?? emptyCapacityCounter();
  if (event.event_id <= summary.last) return;
  if (summary.version !== CAPACITY_VERSION || !Number.isSafeInteger(event.event_id) || !Number.isFinite(at)) {
    write('capacity-summary', { ...summary, invalid: true });
    return;
  }
  const kind = event.event_kind;
  approvalEvent(event, detail, read, write);
  if (kind === 'hold' && typeof detail.lane === 'string') {
    if (!summary.heldLanes.includes(detail.lane)) summary.heldLanes.push(detail.lane);
  } else if (kind === 'unhold' && typeof detail.lane === 'string') {
    summary.heldLanes = summary.heldLanes.filter(lane => lane !== detail.lane);
  }
  if (kind === 'landing_batch') landingSample(event, detail, at, read, write);
  if (event.item_id !== null && event.item_id !== undefined) {
    const key = `capacity-item:${event.item_id}`;
    const item = read(key) ?? newItem(event.item_id);
    const before = { state: item.state, claimAt: item.claimAt, leaseUntil: item.leaseUntil,
      commit: item.commit, reserve: item.reserve ? { ...item.reserve } : null };
    const expired = before.state === 'claimed' && Number.isFinite(before.leaseUntil) && before.leaseUntil <= at;
    if (expired) {
      item.returnedAt ??= before.leaseUntil;
      item.returnKind ??= 'unknown';
      item.buildFrom = null; item.buildBy = null; item.buildRoute = null;
    }
    landingOutcome(event, detail, at, item, before, write);
    // Even an item fact may expire its claim. Canonical and measurement state advance together.
    moveFlowItem(item, event, detail, at);
    if (kind === 'add') {
      item.historyKnown = true;
      item.route = typeof detail.route === 'string' ? detail.route : null;
      item.after = Array.isArray(detail.after) ? [...detail.after] : null;
      item.held = false;
    }
    if (kind === 'escalate' && typeof detail.to === 'string') item.route = detail.to;
    if (kind === 'edit') {
      if (typeof detail.route === 'string') item.route = detail.route;
      if (Array.isArray(detail.after)) item.after = [...detail.after];
    }
    // Existing add/edit events omit brief/files. Only explicit array metadata is historical evidence.
    if (Array.isArray(detail.files) && detail.files.every(file => typeof file === 'string')) item.files = [...new Set(detail.files)];
    if (kind === 'hold_item') item.held = true;
    if (kind === 'unhold_item') item.held = false;
    if (kind === 'claim') {
      if (Number.isFinite(item.returnedAt)) {
        sample(event, at, 'reworkGap', { route: item.route, hours: hours(item.returnedAt, at),
          attempt: item.returnKind ?? 'unknown', size: item.submission?.size ?? null }, write);
      }
      item.attempt = item.returnKind ?? (item.historyKnown && item.claimCount === 0 ? 'first' : 'unknown');
      if (item.historyKnown && item.claimCount === 0) item.cycleStart = at;
      item.claimCount += 1;
      item.buildFrom = at; item.buildBy = event.event_by; item.buildRoute = item.route;
      item.returnedAt = null; item.returnKind = null;
    }
    if (kind === 'submit') {
      const size = submissionSize(detail);
      const liveClaim = before.state === 'claimed' && !expired && Number.isFinite(before.leaseUntil)
        && item.buildBy === event.event_by;
      sample(event, at, 'build', { route: item.buildRoute ?? item.route, size, attempt: item.attempt,
        hours: liveClaim ? hours(item.buildFrom, at) : null }, write);
      item.submission = { at, commit: detail.commit ?? null, size, route: item.buildRoute ?? item.route,
        attempt: item.attempt, waitRecorded: false };
      item.buildFrom = null; item.buildBy = null; item.buildRoute = null;
    }
    if (kind === 'reserve' && before.state === 'submitted' && item.submission?.commit === before.commit
      && !item.submission.waitRecorded) {
      sample(event, at, 'reviewWait', { route: item.submission.route, size: item.submission.size,
        attempt: item.submission.attempt, hours: hours(item.submission.at, at) }, write);
      item.submission.waitRecorded = true;
    }
    const matching = ['accept', 'reject'].includes(kind) && before.state === 'submitted'
      && typeof before.commit === 'string' && detail.commit === before.commit;
    if (matching) {
      const submitted = item.submission?.commit === before.commit ? item.submission : null;
      const metadata = { route: submitted?.route ?? item.route, size: submitted?.size ?? null,
        attempt: submitted?.attempt ?? 'unknown' };
      const reservation = before.reserve;
      const validReview = submitted && reservation?.by === event.event_by
        && Number.isFinite(reservation.until) && reservation.until >= at
        && Number.isFinite(reservation.at) && reservation.at >= submitted.at;
      sample(event, at, 'review', { ...metadata, hours: validReview ? hours(reservation.at, at) : null }, write);
      if (!submitted?.waitRecorded) sample(event, at, 'reviewWait', { ...metadata, hours: null }, write);
      sample(event, at, 'decision', { ...metadata, accepted: kind === 'accept' }, write);
      if (kind === 'accept') item.landingEpisode = { commit: before.commit, acceptEvent: event.event_id,
        route: metadata.route, size: metadata.size };
      if (kind === 'accept' && !item.cycleRecorded) {
        sample(event, at, 'cycle', { ...metadata, hours: item.historyKnown ? hours(item.cycleStart, at) : null }, write);
        item.cycleRecorded = true;
      }
      if (kind === 'reject') {
        item.returnedAt ??= at; item.returnKind = 'reject';
      }
    }
    const returned = RETURNS.has(kind) && !(kind === 'refreeze' && detail.retainedClaim)
      || kind === 'release' && !detail.review && before.state !== 'submitted';
    if (returned) {
      item.returnedAt ??= at;
      item.returnKind = returnKind(kind, detail);
      item.buildFrom = null; item.buildBy = null; item.buildRoute = null;
    }
    write(key, item);
  }
  summary.last = event.event_id;
  write('capacity-summary', summary);
}
