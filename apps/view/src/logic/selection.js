/** Select and order the Items view from explicit observations, without reading browser or board globals. */
export function selectItemsView({ items, query = '', matchedIds = [], readyIds = [], stateById, state, lane, pipeline = false,
  dashboardList = null, dashboardNext = [], selectedId = null, currentBoard = true, adding = false, addressDetail = null,
  tab = 'items', snapshot = false }) {
  const matched = new Set(matchedIds);
  const ready = new Set(readyIds);
  if (!(stateById instanceof Map)) throw new TypeError('stateById must be a Map of item ids to state observations');
  const observations = stateById;
  const stateOf = item => observations.get(item.id)?.state;
  const gatedOf = item => observations.get(item.id)?.gated === true;
  const mergedOf = item => observations.get(item.id)?.merged === true;
  const matching = (query ? items : items.filter(item => item.status !== 'withdrawn'))
    .filter(item => !query || matched.has(item.id));

  const names = { active: 'Active', verified: 'Verified', all: 'All' };
  if (state === 'verify') names.verify = 'In review';
  if (state === 'gated') names.gated = 'Gated';
  if (state === 'ready') names.ready = 'Ready, in rank order';
  // The Dashboard's step cards open these three steps; like Gated, each shows only while chosen.
  if (state === 'building') names.building = 'Building';
  if (state === 'passed') names.passed = 'Passed, landing next';
  if (state === 'landed') names.landed = 'Landed';

  const selectedLane = lane && !matching.some(item => item.lane === lane) ? null : lane;
  const inLane = item => !selectedLane || item.lane === selectedLane;
  const inState = value => item => value === 'ready' ? ready.has(item.id)
    : value === 'all' || (value === 'active' ? !['verified', 'withdrawn'].includes(stateOf(item))
      : value === 'gated' ? gatedOf(item)
        : value === 'passed' ? stateOf(item) === 'verified' && !mergedOf(item)
          : value === 'landed' ? mergedOf(item) : stateOf(item) === value);
  const stateOptions = Object.entries(names).map(([value, label]) => ({
    value, label, count: matching.filter(inLane).filter(inState(value)).length,
  }));
  const inView = pipeline ? matching.filter(item => item.status !== 'withdrawn') : matching.filter(inState(state));
  const laneCounts = [...inView.reduce((counts, item) => counts.set(item.lane, (counts.get(item.lane) || 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (selectedLane && !laneCounts.some(([value]) => value === selectedLane)) laneCounts.push([selectedLane, 0]);
  const laneOptions = [{ value: '', label: 'All lanes', count: null }, ...laneCounts.map(([value, count]) => ({ value, label: value, count }))];
  const readyOrder = new Map(dashboardNext.map((id, index) => [id, index]));
  const shown = inView.filter(inLane).sort((a, b) => dashboardList === 'next' && state === 'ready'
    ? (readyOrder.get(a.id) ?? Infinity) - (readyOrder.get(b.id) ?? Infinity) || a.id - b.id
    : dashboardList === 'review' && state === 'verify'
      ? (a.since || a.updatedAt).localeCompare(b.since || b.updatedAt)
      : b.updatedAt.localeCompare(a.updatedAt));
  const finishedUnderAll = !shown.length && items.length > 0 && items.every(item => stateOf(item) === 'verified')
    && tab === 'items' && !pipeline && state === 'active' && !selectedLane && !query && !snapshot;
  const nextSelectedId = currentBoard && !adding && !(tab === 'items' && addressDetail !== null && addressDetail !== 'pipeline')
    && !items.some(item => item.id === selectedId) ? shown[0]?.id ?? null : selectedId;
  const stateLabel = pipeline || state === 'active' ? '' : names[state] || '';
  const filterLabel = stateLabel || selectedLane ? 'Filter: ' + [stateLabel, selectedLane].filter(Boolean).join(' · ') : 'Filter';
  return { matching, stateOptions, laneOptions, selectedLane, inView, shown, finishedUnderAll, nextSelectedId, filterLabel };
}
