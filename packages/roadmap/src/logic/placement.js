/** Deterministic release placement from existing spec, lane and prerequisite assignments [N26,B35]. */
import { isLanded } from './progress.js';

/** Resolve a local reference; foreign board references have no comparable local release index. */
function localId(value) {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : null;
}

/**
 * Choose the spec or lane release, raised to every prerequisite's release, and retain unavailable inputs. Under the
 * live-release engine the spec and lane rules consider only releases still holding unlanded work.
 */
export function placementFor(entries, { lane, specIds = [], after = [] }, itemOf, { liveReleases = true } = {}) {
  const catalog = entries.map((entry, index) => ({ entry, index }));
  const open = catalog.filter(({ entry }) => !entry.shipped);
  // A release never recorded shipped whose items have all landed (merged to main) or been withdrawn is history, not a
  // home: its old items must not pull new work into it by spec row or lane. An accepted item not yet merged is still
  // unlanded work, as work progress and milestone ship read it [C7].
  const live = !liveReleases ? open : open.filter(({ entry }) => entry.items.some(ref => {
    const row = itemOf(localId(ref));
    return Boolean(row) && row.item_status !== 'withdrawn' && !isLanded(row);
  }));
  /** Find the first unshipped release still holding unlanded work that contains a live item supplying this input. */
  const holding = matches => live.find(({ entry }) => entry.items.some(ref => {
    const id = localId(ref), row = id === null ? null : itemOf(id);
    return Boolean(row) && row.item_status !== 'withdrawn' && matches(row);
  }));
  const waits = after.map(ref => {
    const id = localId(ref);
    const at = id === null ? undefined : catalog.filter(({ entry }) => entry.items.some(member => localId(member) === id)).at(-1);
    return { id: id ?? ref, at };
  });
  const floor = waits.reduce((max, row) => Math.max(max, row.at?.index ?? -1), -1);
  const rows = new Set(specIds);
  const spec = rows.size ? holding(row => String(row.item_spec_ids ?? '').split(',').some(id => rows.has(id))) : undefined;
  const current = open.find(({ entry }) => !entry.items.length || entry.items.some(ref => itemOf(localId(ref))?.item_status !== 'verified')) ?? open[0];
  const laneRelease = holding(row => row.item_lane === lane && row.item_status !== 'verified');
  let chosen = spec ?? laneRelease ?? current;
  let rule = spec ? 'spec rows' : laneRelease ? 'lane release' : 'current release';
  if (chosen && floor > chosen.index) { chosen = open.find(({ index }) => index >= floor); rule = 'dependencies'; }
  const inputs = {
    after: waits.map(row => ({ id: row.id, milestone: row.at?.entry.name ?? null })),
    specs: rows.size ? { rows: [...rows], milestone: spec?.entry.name ?? null } : null,
    lane: { lane, milestone: (laneRelease ?? current)?.entry.name ?? null },
  };
  return { index: chosen?.index ?? -1, milestone: chosen?.entry.name ?? null, rule: chosen ? rule : 'no open release', inputs };
}

/** Render the decision and its inputs, including the reason a catalog cannot currently place the item. */
export function placementNote(placed) {
  const parts = [placed.milestone ? `placed in ${placed.milestone} by ${placed.rule}` : 'not placed: no suitable unshipped milestone'];
  if (placed.inputs.after.length) parts.push(`waits on ${placed.inputs.after.map(row => `#${row.id} in ${row.milestone ?? 'no milestone'}`).join(', ')}`);
  if (placed.inputs.specs) parts.push(`rows ${placed.inputs.specs.rows.join(',')} -> ${placed.inputs.specs.milestone ?? 'no milestone'}`);
  parts.push(`lane ${placed.inputs.lane.lane} -> ${placed.inputs.lane.milestone ?? 'no milestone'}`);
  if (placed.full?.length) parts.push(`moved past full ${placed.full.join(', ')}`);
  if (placed.position) parts.push(`position ${placed.position}`);
  return parts.join('; ');
}
