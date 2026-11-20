/** Local timing and board events projected into bounded seat states [C7,N2]. */
import { gitExecFileSync } from '../../../git/index.js';
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../fs/index.js';
const fileSystem = fileSystemAdapter();

/** Ignore malformed or partially written tail records rather than inventing time. */
export function readSeatTiming(common) {
  try { return fileSystem.readFile(join(common, 'pullboard', 'seat-timing.jsonl'), 'utf8').split('\n').flatMap(line => { try { const row = JSON.parse(line); return row.version === 1 && row.seat && row.id ? [row] : []; } catch { return []; } }); }
  catch { return []; }
}

/** Most recent tracked or untracked edit visible in a seat's local worktree. */
export function worktreeActivity(path) {
  if (!path) return null;
  try {
    const files = gitExecFileSync(['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: path, encoding: 'utf8', timeout: 5000 }).split('\0');
    let latest = null;
    for (const row of files) {
      if (row.length < 4) continue;
      try { const at = fileSystem.stat(join(path, row.slice(3))).mtimeMs; latest = Math.max(latest ?? 0, at); } catch { /* Deleted files have no mtime. */ }
    }
    return latest;
  } catch { return null; }
}

/** Compute each seat's current state and 24-hour split from actual events and measured spans. */
export function seatLedger(agents, items, events, records, now = Date.now(), activity = new Map()) {
  const start = now - 24 * 60 * 60 * 1000;
  const history = [...events].sort((a, b) => Date.parse(a.event_at) - Date.parse(b.event_at));
  const spans = new Map();
  for (const row of records) {
    const old = spans.get(row.id);
    if (!old || row.phase === 'end') spans.set(row.id, row);
  }
  return agents.map(agent => {
    const mine = history.filter(event => event.event_by === agent.agent_id);
    const claims = items.filter(item => item.item_status === 'claimed' && item.item_owner === agent.agent_id);
    const handoffFor = item => { const event = [...mine].reverse().find(row => row.event_kind === 'submit-handoff' && row.item_id === item.item_id); try { return JSON.parse(event?.event_detail ?? '{}').state; } catch { return null; } };
    // A handed-off gate does not keep a seat from building a newer claim.
    const held = claims.find(item => !['queued', 'running'].includes(handoffFor(item))) ?? claims[0];
    const review = items.find(item => item.item_status === 'submitted' && item.item_review_by === agent.agent_id && Date.parse(item.item_review_until) > now);
    const last = mine.at(-1), lastAt = last ? Date.parse(last.event_at) : null;
    if (!held && !review && (!lastAt || now - lastAt > 3 * 60 * 60 * 1000)) return null;
    const own = [...spans.values()].filter(span => span.seat === agent.agent_id && span.start <= now && (span.end ?? now) >= start);
    const active = own.filter(span => !span.end && span.pid && (() => { try { process.kill(span.pid, 0); return true; } catch { return false; } })());
    const lastHandoff = [...mine].reverse().find(event => event.event_kind === 'submit-handoff' && event.item_id === held?.item_id);
    let handoff = {}; try { handoff = JSON.parse(lastHandoff?.event_detail ?? '{}'); } catch { /* Ignore malformed event. */ }
    const awaiting = items.find(item => item.item_status === 'submitted' && item.item_built_by === agent.agent_id && !item.item_review_by);
    const waiting = active.find(span => ['lock-wait', 'runner-wait'].includes(span.kind));
    const state = waiting ? (waiting.kind === 'lock-wait' ? 'waiting on lock' : 'waiting on runner slot')
      : review ? 'reviewing' : held ? (['queued', 'running'].includes(handoff.state) ? 'waiting on gate' : lastAt && now - Math.max(lastAt, activity.get(agent.agent_id) ?? 0) >= 20 * 60 * 1000 && !active.length ? 'silent' : 'building')
        : awaiting ? 'waiting on review' : 'idle';
    const transitionKinds = state === 'building' || state === 'silent' ? ['claim'] : state === 'reviewing' ? ['reserve'] : state === 'waiting on review' ? ['submit'] : ['release', 'withdraw', 'accept', 'reject'];
    const transition = [...mine].reverse().find(event => transitionKinds.includes(event.event_kind) && (!held || event.item_id === held.item_id));
    const since = waiting?.start ?? (state === 'waiting on gate' ? Date.parse(lastHandoff.event_at) : null) ?? (transition ? Date.parse(transition.event_at) : null) ?? lastAt ?? now;
    // Split on observed state changes and measured command boundaries; unknown history stays unknown.
    const states = { building: 0, reviewing: 0, gate: 0, reviewWait: 0, lockWait: 0, runnerWait: 0, command: 0, test: 0, silent: 0, idle: 0, unknown: 0 };
    const eventRows = mine.filter(event => { const time = Date.parse(event.event_at); return Number.isFinite(time) && time >= start && time <= now; });
    const bounds = new Set([start, now]);
    for (const event of eventRows) { const at = Date.parse(event.event_at); bounds.add(at); if (at + 20 * 60000 < now) bounds.add(at + 20 * 60000); }
    for (const span of own) { bounds.add(Math.max(start, span.start)); bounds.add(Math.min(now, span.end ?? (active.includes(span) ? now : span.start))); }
    const points = [...bounds].filter(at => at >= start && at <= now).sort((a, b) => a - b);
    let index = 0, current = 'unknown', observedAt = null, owned = null;
    for (let n = 0; n < points.length - 1; n++) {
      const tick = points[n];
      while (index < eventRows.length && Date.parse(eventRows[index].event_at) <= tick) {
        const event = eventRows[index++]; observedAt = Date.parse(event.event_at);
        if (event.event_kind === 'claim') { owned = event.item_id; current = 'building'; }
        else if (event.event_kind === 'reserve') { owned = event.item_id; current = 'reviewing'; }
        else if (event.event_kind === 'submit-handoff') {
          let detail = {}; try { detail = JSON.parse(event.event_detail ?? '{}'); } catch { /* Ignore malformed event. */ }
          if (['queued', 'running'].includes(detail.state) && owned === event.item_id) current = 'gate';
          else if (current === 'gate') current = 'building';
        } else if (event.event_kind === 'submit') { owned = null; current = 'reviewWait'; }
        else if (['release', 'withdraw', 'accept', 'reject'].includes(event.event_kind)) { owned = null; current = 'idle'; }
      }
      const running = own.filter(span => span.start <= tick && (span.end ?? (active.includes(span) ? now : span.start)) > tick);
      const key = running.some(span => span.kind === 'lock-wait') ? 'lockWait'
        : running.some(span => span.kind === 'runner-wait') ? 'runnerWait'
          : running.some(span => span.kind === 'test') ? 'test'
            : running.some(span => span.kind === 'command') ? 'command'
              : ['building', 'reviewing'].includes(current) && tick - observedAt >= 20 * 60000 ? 'silent' : current;
      states[key] += points[n + 1] - tick;
    }
    const split = { commandMs: 0, testMs: 0, runnerWaitMs: 0, lockWaitMs: 0, states };
    for (const span of own) {
      const end = span.end ?? (active.includes(span) ? now : span.start);
      const key = span.kind === 'test' ? 'testMs' : span.kind === 'runner-wait' ? 'runnerWaitMs' : span.kind === 'lock-wait' ? 'lockWaitMs' : 'commandMs';
      split[key] += Math.max(0, Math.min(now, end) - Math.max(start, span.start));
    }
    const built = new Set(items.filter(item => item.item_built_by === agent.agent_id).map(item => item.item_id));
    const landed = history.filter(event => event.event_kind === 'merged' && built.has(event.item_id) && Date.parse(event.event_at) >= start).length;
    return { seat: agent.agent_id, state, item: held?.item_id ?? review?.item_id ?? awaiting?.item_id ?? null, minutes: Math.floor(Math.max(0, now - since) / 60000), split, landed };
  }).filter(Boolean);
}

/** Format one readable line for each seat; JSON keeps exact milliseconds. */
export function seatLines(rows) {
  return rows.map(row => `${row.seat}: ${row.state}${row.item ? ` #${row.item}` : ''} for ${row.minutes}m; last 24h command ${(row.split.commandMs / 60000).toFixed(1)}m, tests ${(row.split.testMs / 60000).toFixed(1)}m, runner wait ${(row.split.runnerWaitMs / 60000).toFixed(1)}m, lock wait ${(row.split.lockWaitMs / 60000).toFixed(1)}m, states ${Object.entries(row.split.states).map(([name, ms]) => `${name} ${(ms / 60000).toFixed(1)}m`).join(', ')}, landed ${row.landed}`);
}
