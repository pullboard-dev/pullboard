/** Measure native coordinator actions and first landings over one explicit window [B35,R2]. */
const KINDS = ['shout', 'fact', 'placement', 'landing', 'holdOrRelease', 'rejectReturn', 'ruling', 'other'];

/** Keep real judgements separate from mechanical notes; retain unclassified native actions explicitly. */
function actionKind(event, detail) {
  const kind = event.event_kind;
  if (kind === 'answer') return 'ruling';
  if (['shout', 'shout_news', 'pass'].includes(kind)) return 'shout';
  if (kind === 'fact') return ['decision', 'ruling', 'root-cause', 'rejection', 'supersession'].includes(detail.kind) ? 'ruling' : 'fact';
  if (['merged', 'milestone_ship', 'main-moved', 'train_landing'].includes(kind) || kind.startsWith('landing_') || kind.startsWith('landing-')) return 'landing';
  if (['hold', 'unhold', 'hold_item', 'unhold_item', 'release', 'release_lane'].includes(kind)) return 'holdOrRelease';
  if (['reject_returned', 'submit_handoff_returned'].includes(kind)) return 'rejectReturn';
  if (['add', 'edit', 'reroute', 'placement'].includes(kind) || kind.startsWith('milestone_')) return 'placement';
  if (['row_decision', 'row_decisions', 'sentinel_decision', 'pass_decision', 'answer_decision'].includes(kind)) return 'ruling';
  return 'other';
}

/** Count all native actions by the coordinator, including work not landed yet; deduplicate first landings. */
export function coordinatorActionStats(history, { since, until }) {
  const start = Date.parse(since), end = Date.parse(until);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new TypeError('coordinator actions need an ordered finite window');
  const counts = Object.fromEntries(KINDS.map(kind => [kind, 0]));
  const firstLandings = new Map();
  for (const event of history) {
    const at = Date.parse(event.event_at);
    if (!Number.isFinite(at) || at > end) continue;
    if (event.event_kind === 'merged' && event.item_id != null) {
      firstLandings.set(event.item_id, Math.min(firstLandings.get(event.item_id) ?? Infinity, at));
    }
    if (at < start || event.event_by !== 'coordinator') continue;
    const detail = JSON.parse(event.event_detail);
    counts[actionKind(event, detail)] += 1;
  }
  const landedItems = [...firstLandings].filter(([, at]) => at >= start).map(([id]) => id).sort((a, b) => a - b);
  const actions = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return { version: 1, available: true, since: new Date(start).toISOString(), until: new Date(end).toISOString(),
    population: 'native events by coordinator in this window / distinct items first landed in this window',
    actions, landed: landedItems.length, landedItems, perLanding: landedItems.length ? actions / landedItems.length : null,
    byKind: Object.fromEntries(KINDS.map(kind => [kind, { count: counts[kind], perLanding: landedItems.length ? counts[kind] / landedItems.length : null }])) };
}

/** Report the observation boundary and each kind without inventing a rate when nothing landed. */
export function coordinatorActionLines(report) {
  const rate = value => value === null ? 'unmeasured' : String(Number(value.toFixed(3)));
  return [`coordinator actions: ${report.actions} / ${report.landed} landed items = ${rate(report.perLanding)} per landing; ${report.since} to ${report.until}`,
    `population: ${report.population}`, ...Object.entries(report.byKind).map(([kind, row]) => `  ${kind}: ${row.count}; ${rate(row.perLanding)} per landing`)];
}

/** Compare the same observation window size; an override never hides which per-kind rates rose. */
export function coordinatorActionRise(current, previous) {
  if (previous?.perLanding == null) return null;
  if (current.perLanding === null) return 'coordinator actions per landing are unmeasured: no items landed in the release window';
  if (current.perLanding <= previous.perLanding) return null;
  const rose = Object.keys(current.byKind).filter(kind => current.byKind[kind].perLanding > (previous.byKind[kind]?.perLanding ?? 0));
  return `coordinator actions per landing rose from ${previous.perLanding} to ${current.perLanding}; kinds that rose: ${rose.join(', ')}`;
}
