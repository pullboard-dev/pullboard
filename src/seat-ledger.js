/** Local timing and board events projected into bounded seat states [C7,N2]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Ignore malformed or partially written tail records rather than inventing time. */
export function readSeatTiming(common) {
  try { return readFileSync(join(common, 'pullboard', 'seat-timing.jsonl'), 'utf8').split('\n').flatMap(line => { try { const row = JSON.parse(line); return row.version === 1 && row.seat && row.id ? [row] : []; } catch { return []; } }); }
  catch { return []; }
}

/** Compute each seat's current state and 24-hour split from actual events and measured spans. */
export function seatLedger(agents, items, events, records, now = Date.now()) {
  const start = now - 24 * 60 * 60 * 1000;
  const history = [...events].sort((a, b) => Date.parse(a.event_at) - Date.parse(b.event_at));
  const spans = new Map();
  for (const row of records) {
    const old = spans.get(row.id);
    if (!old || row.phase === 'end') spans.set(row.id, row);
  }
  return agents.map(agent => {
    const mine = history.filter(event => event.event_by === agent.agent_id);
    const held = items.find(item => item.item_status === 'claimed' && item.item_owner === agent.agent_id);
    const review = items.find(item => item.item_status === 'submitted' && item.item_review_by === agent.agent_id && Date.parse(item.item_review_until) > now);
    const last = mine.at(-1), lastAt = last ? Date.parse(last.event_at) : null;
    if (!held && !review && (!lastAt || now - lastAt > 3 * 60 * 60 * 1000)) return null;
    const own = [...spans.values()].filter(span => span.seat === agent.agent_id && span.start <= now && (span.end ?? now) >= start);
    const active = own.filter(span => !span.end && span.pid && (() => { try { process.kill(span.pid, 0); return true; } catch { return false; } })());
    const state = review ? 'reviewing' : held ? (active.some(span => span.kind === 'runner-wait') ? 'waiting on runner slot' : lastAt && now - lastAt >= 20 * 60 * 1000 && !active.length ? 'silent' : 'building') : 'idle';
    const since = active.find(span => span.kind === 'runner-wait')?.start ?? lastAt ?? now;
    const split = { commandMs: 0, testMs: 0, runnerWaitMs: 0 };
    for (const span of own) {
      const end = span.end ?? (active.includes(span) ? now : span.start);
      const key = span.kind === 'test' ? 'testMs' : span.kind === 'runner-wait' ? 'runnerWaitMs' : 'commandMs';
      split[key] += Math.max(0, Math.min(now, end) - Math.max(start, span.start));
    }
    const built = new Set(items.filter(item => item.item_built_by === agent.agent_id).map(item => item.item_id));
    const landed = history.filter(event => event.event_kind === 'merged' && built.has(event.item_id) && Date.parse(event.event_at) >= start).length;
    return { seat: agent.agent_id, state, item: held?.item_id ?? review?.item_id ?? null, minutes: Math.floor(Math.max(0, now - since) / 60000), split, landed };
  }).filter(Boolean);
}
