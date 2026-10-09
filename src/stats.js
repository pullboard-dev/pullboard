/** Public proof numbers derived from the append-only event log [R1,R2]. */
import { events } from './board.js';
import { Refused } from './refused.js';

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
function actorsFrom(history, boundary) {
  const declared = new Map();
  const actors = new Map();
  const families = new Map();
  for (const event of history) {
    const id = event.event_by;
    if (id === 'board' || id === 'person') continue;
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

/** Assemble the public statistics shared by the CLI and local board state from one event snapshot. */
export function proofStats(board, { since } = {}) {
  const boundary = sinceDate(since);
  const history = events(board);
  return { ...countsFrom(history, boundary), ...actorsFrom(history, boundary) };
}
