/** Public proof numbers derived from the append-only event log [R1,R2]. */
import { events } from '../../../../packages/store/index.js';
import { Refused } from '../../../../packages/kernel/light.js';
import { flowStats } from '../../../../packages/stats/index.js';
import { barStats } from '../../../../packages/stats/index.js';
import { caughtFrom } from '../../../../packages/items/index.js';

/** Return only registered proof seats, matching public actor eligibility without using the counter path. */
function proofAgentsFrom(board) {
  return new Set(board.db.prepare('SELECT agent_id, agent_lane FROM agent').all()
    .filter(({ agent_id: id, agent_lane: lane }) => lane !== 'coordinator'
      && !['board', 'person', 'clock', 'coordinator', 'rigor', 'sentinel'].includes(id))
    .map(({ agent_id: id }) => id));
}

/** Parse an inclusive UTC date boundary, refusing malformed or impossible dates. */
export function sinceDate(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/u.exec(text);
  const milliseconds = match ? Date.parse(text) : NaN;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== match?.[1]) {
    throw new Refused('BAD_SINCE', 'the since date is invalid; use --since YYYY-MM-DD or an ISO UTC timestamp, for example --since 2026-10-08');
  }
  return new Date(milliseconds).toISOString();
}

/** Count moves in a window while auditing merges against their complete earlier history. */
function countsFrom(history, boundary) {
  const selected = history.filter((event) => !boundary || Date.parse(event.event_at) >= Date.parse(boundary));
  const selectedIds = new Set(selected.map((event) => event.event_id));
  let submissions = 0;
  let rejections = 0;
  const merged = new Set();
  const withoutAccept = new Set();
  const submitted = new Map();
  const accepted = new Map();
  for (const event of history) {
    const detail = JSON.parse(event.event_detail);
    if (event.event_kind === 'submit') {
      submitted.set(event.item_id, detail.commit);
      accepted.delete(event.item_id);
      if (selectedIds.has(event.event_id)) submissions += 1;
    } else if (event.event_kind === 'accept') {
      if (detail.commit && detail.commit === submitted.get(event.item_id)) accepted.set(event.item_id, detail.commit);
    } else if (event.event_kind === 'reject') {
      accepted.delete(event.item_id);
      if (selectedIds.has(event.event_id)) rejections += 1;
    } else if (event.event_kind === 'merged' && selectedIds.has(event.event_id)) {
      merged.add(event.item_id);
      if (!accepted.has(event.item_id)) withoutAccept.add(event.item_id);
    }
  }
  const dates = selected.map((event) => event.event_at).sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    since: boundary,
    submissions,
    rejections,
    rejectionShare: submissions ? rejections / submissions : 0,
    merged: merged.size,
    mergedWithoutAccept: withoutAccept.size,
    firstEventAt: dates[0] ?? null,
    lastEventAt: dates.at(-1) ?? null,
  };
}

/** Count lifecycle moves from one immutable read of the event history. */
export function eventCounts(board, { since } = {}) {
  return countsFrom(events(board), sinceDate(since));
}

/** Attribute only recorded actor families, retaining earlier declarations across date windows. */
function actorsFrom(history, boundary, seats) {
  const declared = new Map();
  const actors = new Map();
  const families = new Map();
  for (const event of history) {
    const id = event.event_by;
    if (!seats.has(id)) continue;
    const detail = JSON.parse(event.event_detail);
    if (Object.hasOwn(detail, 'family')) {
      declared.set(id, typeof detail.family === 'string' && detail.family.trim() ? detail.family : 'unknown');
    }
    if (boundary && Date.parse(event.event_at) < Date.parse(boundary)) continue;
    const name = declared.get(id) ?? 'unknown';
    if (!actors.has(id)) actors.set(id, { id, moves: 0, families: new Set() });
    const actor = actors.get(id);
    actor.moves += 1;
    actor.families.add(name);
    if (!families.has(name)) families.set(name, { name, agents: new Set(), moves: 0 });
    const family = families.get(name);
    family.moves += 1;
    family.agents.add(id);
  }
  const agents = [...actors.keys()].sort().map((id) => {
    const actor = actors.get(id);
    return { ...actor, families: [...actor.families].sort() };
  });
  const groups = [...families.keys()].sort().map((name) => {
    const family = families.get(name);
    return { ...family, agents: family.agents.size };
  });
  return { agentCount: agents.length, familyCount: groups.length, agents, families: groups };
}

/** Independently derive note ratios from native history, including seats without a submission [R1,R2]. */
function notesFrom(history, boundary, seats) {
  const rows = new Map();
  for (const event of history) {
    if (!seats.has(event.event_by)
      || boundary && Date.parse(event.event_at) < Date.parse(boundary)) continue;
    const note = event.event_kind === 'fact' && JSON.parse(event.event_detail).kind === 'note';
    if (!note && event.event_kind !== 'submit') continue;
    const row = rows.get(event.event_by) ?? { seat: event.event_by, notes: 0, submits: 0 };
    if (note) row.notes += 1; else row.submits += 1;
    rows.set(event.event_by, row);
  }
  return [...rows.keys()].sort().map(seat => {
    const row = rows.get(seat);
    return { ...row, notesPerSubmit: row.submits ? row.notes / row.submits : null };
  });
}

/** Independently count releases before work while preserving each seat's claim lifecycle. */
function workFreeReleasesFrom(history, boundary) {
  const claims = new Map();
  const counts = new Map();
  for (const event of history) {
    if (event.item_id == null) continue;
    const detail = JSON.parse(event.event_detail);
    const id = event.item_id;
    if (event.event_kind === 'claim') {
      const previous = claims.get(id);
      if (!previous || previous.seat !== event.event_by || previous.until && previous.until <= event.event_at) {
        claims.set(id, { seat: event.event_by, worked: false, until: detail.leaseUntil });
      } else if (detail.leaseUntil) previous.until = detail.leaseUntil;
    } else if (event.event_kind === 'renew') {
      const claim = claims.get(id);
      if (claim && detail.leaseUntil) claim.until = detail.leaseUntil;
    } else if (['submit', 'accept', 'reject', 'reopen', 'send-back'].includes(event.event_kind)) {
      const claim = claims.get(id);
      if (claim) claim.worked = true;
    } else if (event.event_kind === 'release' && !detail.review) {
      const claim = claims.get(id);
      if (claim && !claim.worked && /^\d{4}-\d\d-\d\dT/u.test(event.event_at ?? '')
        && (!boundary || event.event_at >= boundary)) {
        const day = event.event_at.slice(0, 10);
        const reason = detail.reasonCode ?? 'UNKNOWN';
        const key = JSON.stringify([day, claim.seat, reason]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      claims.delete(id);
    } else if (['lapse', 'withdraw', 'merged'].includes(event.event_kind)) claims.delete(id);
  }
  return [...counts].map(([key, count]) => {
    const [day, seat, reason] = JSON.parse(key);
    return { day, seat, reason, count };
  }).sort((a, b) => a.day.localeCompare(b.day) || a.seat.localeCompare(b.seat) || a.reason.localeCompare(b.reason));
}

/** Assemble the public statistics shared by the CLI and local board state from one event snapshot. */
export function proofStats(board, { since, now = Date.now() } = {}) {
  const boundary = sinceDate(since);
  const history = events(board);
  const counts = countsFrom(history, boundary);
  const verdicts = board.db.prepare('SELECT * FROM verdict ORDER BY verdict_id').all();
  const seats = proofAgentsFrom(board);
  return { ...counts, ...actorsFrom(history, boundary, seats), bars: barStats(history, verdicts, boundary), caught: caughtFrom(history, verdicts, boundary),
    flow: flowStats(history, boundary, now, counts, { agentIds: seats }), notesPerSubmit: notesFrom(history, boundary, seats),
    workFreeReleases: workFreeReleasesFrom(history, boundary) };
}
