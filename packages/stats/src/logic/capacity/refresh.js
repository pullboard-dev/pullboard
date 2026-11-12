/** Local derived capacity snapshots: nightly empirical fits and bounded forecast cadence [R1,R2]. */
import { itemFiles } from '../../../../items/light.js';
import { fitCapacity } from './model.js';
import { planCapacity } from './model.js';

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Read current planning metadata without treating today's files as historical attempt measurements. */
function pendingItems(board, read, now) {
  const held = new Set(board.db.prepare('SELECT hold_lane FROM hold').all().map(row => row.hold_lane));
  const approvals = read('capacity-approvals')?.rows ?? {};
  const pending = board.db.prepare("SELECT * FROM item WHERE item_status!='withdrawn' AND item_merged_commit IS NULL ORDER BY item_id").all();
  const result = pending.map(row => {
    const ids = row.item_spec_ids.split(',').filter(Boolean);
    const expired = row.item_status === 'claimed' && Date.parse(row.item_lease_until) <= now;
    return { id: row.item_id, route: row.item_route, state: expired ? 'open' : ({ verified: 'accepted' }[row.item_status] ?? row.item_status),
      builderId: row.item_built_by ?? null, after: row.item_after.split(',').filter(Boolean).map(Number), files: itemFiles(row),
      held: Boolean(row.item_hold_reason || held.has(row.item_lane)), needsYou: ids.some(id => !Object.hasOwn(approvals, id) || approvals[id] !== true) };
  });
  const present = new Set(result.map(item => item.id));
  const dependency = board.db.prepare('SELECT item_id,item_status,item_merged_commit FROM item WHERE item_id=?');
  for (const id of new Set(result.flatMap(item => item.after))) {
    if (present.has(id)) continue;
    const row = dependency.get(id);
    if (row) result.push({ id, state: row.item_merged_commit ? 'merged' : row.item_status === 'verified' ? 'accepted' : row.item_status });
  }
  return result;
}

/** Refresh only at the specified cadence; reads never warm the cache or replay native history. */
export function refreshCapacity(board, read, write, rows, { force = false } = {}) {
  const summary = read('capacity-summary');
  if (!summary || summary.invalid) return;
  const now = board.clock.now().getTime();
  if (!Number.isFinite(now)) return;
  const cadence = read('capacity-cadence');
  if (!force && cadence && now >= cadence.closedAt && now < cadence.closedAt + 5 * MINUTE) return;
  const previous = read('capacity-snapshot');
  const end = Math.floor(now / DAY) * DAY;
  let fit = read('capacity-fit');
  if (!fit || fit.to !== new Date(end).toISOString()) {
    fit = fitCapacity(rows('capacity-sample', end - 7 * DAY, end), { from: end - 7 * DAY, to: end });
    write('capacity-fit', fit);
  }
  const actors = rows('actor').filter(actor => !['board', 'person', 'clock', 'coordinator'].includes(actor.id)
    && actor.flow.lastAt >= now - 60 * MINUTE && actor.flow.lastAt <= now);
  const simulate = force || !previous || !previous.monteCarlo.asOf || now >= Date.parse(previous.monteCarlo.asOf) + 15 * MINUTE;
  const planner = planCapacity({ items: pendingItems(board, read, now), fit, liveSeats: { total: actors.length, ids: actors.map(actor => actor.id) },
    now, sequence: summary.last, seed: `${end}:${Math.floor(now / (15 * MINUTE))}`, simulate });
  if (!planner.available) {
    planner.agents.lower = null; planner.agents.upper = null;
    planner.finishHours = { lower: null, upper: null };
    planner.monteCarlo = { ...planner.monteCarlo, completed: 0, nonFinishing: 0, asOf: null, sequence: null };
  } else if (!simulate) {
    planner.agents.lower = previous.agents.lower;
    planner.agents.upper = previous.agents.upper;
    planner.finishHours = previous.finishHours;
    planner.monteCarlo = previous.monteCarlo;
  } else planner.monteCarlo = { ...planner.monteCarlo, asOf: planner.asOf, sequence: summary.last };
  planner.staffing = { basis: 'recorded activity in the preceding sixty minutes', seats: actors.length, measuredLive: false };
  planner.assumptions.push(`Forecast assumes ${actors.length} available seats from recent recorded activity; live presence is not measured by this index.`);
  planner.cadence = { closedFormMinutes: 5, forecastMinutes: 15, fit: 'nightly, preceding seven UTC days' };
  planner.assumptions.push('Person waits use cited rows in the recorded approval baseline and row decisions; unrecorded approvals remain waits.');
  planner.assumptions.push('Modeled identities require eligible independent reviewers; activity alone does not prove parent, family or verifier standing.');
  write('capacity-snapshot', planner);
  write('capacity-cadence', { closedAt: now, forecastAt: planner.monteCarlo.asOf });
}
