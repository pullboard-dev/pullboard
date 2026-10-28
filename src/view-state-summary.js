/** Compact native view projections; detailed proof accounting remains available on demand [N26,A2]. */

/** Keep flow aggregates without transmitting a proof record for every historical item. */
export function viewFlowSummary(flow) {
  if (!flow?.report) return flow;
  const { items: _items, ...report } = flow.report;
  return { ...flow, report };
}

/** Keep the totals and grouped summaries consumed by the view, leaving detailed CLI stats intact. */
export function viewProofSummary(stats) {
  const { agents: _agents, bars: _bars, caught: _caught, ...summary } = stats;
  return { ...summary, flow: viewFlowSummary(stats.flow) };
}

/** Match the existing four-hour Dashboard activity window, retaining every field of each recently active seat. */
export function activeViewAgents(agents, now) {
  return agents.filter(agent => {
    const at = Date.parse(agent.lastMoveAt);
    return Number.isFinite(at) && at <= now && at >= now - 4 * 3_600_000;
  });
}


/**
 * Factor repeated, explicitly observed summary values into a versioned dictionary. IDs and titles
 * stay on each row. A field with any missing value is never factored, so absence is not a default.
 * The ordinary JSON shape and the source state stay unchanged.
 */
export function compactItemSummaries(state) {
  if (!Array.isArray(state.items) || state.items.length < 2 || Object.hasOwn(state, 'itemEncoding')) return state;
  const items = state.items, defaults = Object.create(null);
  const encoder = new TextEncoder();
  /** Measure the complete UTF-8 representation, including the shared dictionary. */
  const bytes = value => encoder.encode(JSON.stringify(value)).length;
  for (const key of Object.keys(items[0])) {
    if (['id', 'title', '__proto__', 'prototype', 'constructor'].includes(key)
      || items.some(item => !Object.hasOwn(item, key) || item[key] === undefined)) continue;
    const observed = new Map();
    for (const item of items) {
      const value = JSON.stringify(item[key]);
      observed.set(value, (observed.get(value) ?? 0) + 1);
    }
    const [value, count] = [...observed].sort((a, b) => b[1] - a[1])[0];
    if (count < 2) continue;
    Object.defineProperty(defaults, key, { value: JSON.parse(value), enumerable: true });
  }
  if (!Object.keys(defaults).length) return state;
  const rows = items.map(item => Object.fromEntries(Object.entries(item).filter(([key, value]) =>
    !Object.hasOwn(defaults, key) || JSON.stringify(value) !== JSON.stringify(defaults[key]))));
  const itemEncoding = { version: 1, defaults };
  if (bytes({ itemEncoding, items: rows }) >= bytes(items)) return state;
  return { ...state, itemEncoding, items: rows };
}

/**
 * Restore the exact JSON summary values before rendering or applying ordinary state deltas.
 * This function is self-contained so the view embeds this one decoder, without a second protocol.
 */
export function expandItemSummaries(state) {
  if (!Object.hasOwn(state, 'itemEncoding')) return state;
  const encoding = state.itemEncoding;
  if (!encoding || encoding.version !== 1 || !encoding.defaults || typeof encoding.defaults !== 'object'
    || Array.isArray(encoding.defaults) || !Array.isArray(state.items)
    || Object.keys(encoding.defaults).some(key => ['id', 'title', '__proto__', 'prototype', 'constructor'].includes(key))) {
    throw new TypeError('unsupported compact item encoding; request a fresh ordinary board state');
  }
  const defaults = JSON.stringify(encoding.defaults);
  const items = state.items.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !Object.hasOwn(row, 'id')
      || !Number.isSafeInteger(row.id) || row.id < 1 || !Object.hasOwn(row, 'title') || typeof row.title !== 'string') {
      throw new TypeError('invalid compact item row; request a fresh ordinary board state');
    }
    return { ...JSON.parse(defaults), ...row };
  });
  const { itemEncoding: _encoding, ...plain } = state;
  return { ...plain, items };
}
