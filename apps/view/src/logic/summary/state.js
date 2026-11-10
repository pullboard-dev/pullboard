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


/** Build the existing V1 observed-default candidate from normalized JSON rows. */
function defaultItemCandidate(items) {
  const defaults = Object.create(null);
  for (const key of Object.keys(items[0])) {
    if (['id', 'title', '__proto__', 'prototype', 'constructor'].includes(key)
      || items.some(item => !Object.hasOwn(item, key))) continue;
    const observed = new Map();
    for (const item of items) {
      const value = JSON.stringify(item[key]);
      observed.set(value, (observed.get(value) ?? 0) + 1);
    }
    const [value, count] = [...observed].sort((a, b) => b[1] - a[1])[0];
    if (count < 2) continue;
    Object.defineProperty(defaults, key, { value: JSON.parse(value), enumerable: true });
  }
  if (!Object.keys(defaults).length) return null;
  const rows = items.map(item => Object.fromEntries(Object.entries(item).filter(([key, value]) =>
    !Object.hasOwn(defaults, key) || JSON.stringify(value) !== JSON.stringify(defaults[key]))));
  return { itemEncoding: { version: 1, defaults }, items: rows };
}

/** Choose the cheapest complete V1/V2 representation using exact serialized UTF-8 cost. */
export function compactItemSummaries(state) {
  if (!Array.isArray(state.items) || state.items.length < 2 || Object.hasOwn(state, 'itemEncoding')) return state;
  // Normalize once exactly as the ordinary JSON wire omits optional properties and normalizes arrays.
  const items = JSON.parse(JSON.stringify(state.items)), encoder = new TextEncoder();
  /** Include every byte of a candidate representation. */
  const cost = value => encoder.encode(JSON.stringify(value)).length;
  if (items.some(row => !row || typeof row !== 'object' || Array.isArray(row)
    || !Object.hasOwn(row, 'id') || !Number.isSafeInteger(row.id) || row.id < 1
    || !Object.hasOwn(row, 'title') || typeof row.title !== 'string')) return state;
  const keys = [...new Set(items.flatMap(row => Object.keys(row)))];
  const columns = [];
  /** Pick the cheapest of raw, dictionary and time-offset forms for one named column of values. */
  const encodeColumn = (name, values, absent) => {
    let best = [name, 'r', values, absent];
    const missingIndices = new Set(absent);
    const dictionary = [], positions = new Map();
    const indices = values.map((value, index) => {
      if (missingIndices.has(index)) return -1;
      const text = JSON.stringify(value);
      if (text === undefined) return -2;
      if (!positions.has(text)) { positions.set(text, dictionary.length); dictionary.push(value); }
      return positions.get(text);
    });
    if (indices.includes(-2)) return null;
    const dict = [name, 'd', indices, dictionary];
    if (cost(dict) < cost(best)) best = dict;
    const times = values.map(value => typeof value === 'string' ? Date.parse(value) : null);
    if (values.every((value, index) => value === null || (Number.isSafeInteger(times[index])
      && new Date(times[index]).toISOString() === value))) {
      const base = times.find(value => value !== null) ?? 0;
      const timed = [name, 't', times.map(value => value === null ? null : value - base), [base, absent]];
      if (timed[2].every(value => value === null || Number.isSafeInteger(value))
        && cost(timed) < cost(best)) best = timed;
    }
    return best;
  };
  /** A plain JSON object, the only shape a column may be split into one column per field. */
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  for (const key of keys) {
    const absent = [], values = items.map((row, index) => {
      if (!Object.hasOwn(row, key)) { absent.push(index); return null; }
      return row[key];
    });
    const whole = encodeColumn(key, values, absent);
    if (!whole) return state;
    // A column whose every row holds a non-empty object is also tried split by field, so repeated fields cost once.
    const fields = [...new Set(values.flatMap(value => plain(value) ? Object.keys(value) : []))];
    if (!absent.length && fields.length && values.every(plain)) {
      const split = fields.map(field => {
        const missing = [];
        const data = values.map((value, index) => {
          if (!Object.hasOwn(value, field)) { missing.push(index); return null; }
          return value[field];
        });
        return encodeColumn([key, field], data, missing);
      });
      if (split.every(Boolean) && cost(split) < cost(whole)) { columns.push(...split); continue; }
    }
    columns.push(whole);
  }
  const candidates = [defaultItemCandidate(items),
    { itemEncoding: { version: 2, count: items.length }, items: columns }].filter(Boolean);
  let best = state, bestCost = cost(state);
  const ordinaryItemsCost = cost({ items });
  for (const candidate of candidates) {
    const packed = { ...state, ...candidate }, packedCost = cost(packed);
    if (cost(candidate) < ordinaryItemsCost && packedCost < bestCost) {
      best = packed;
      bestCost = packedCost;
    }
  }
  return best;
}

/** Restore ordinary, V1 defaults, or V2 columns; self-contained for browser toString embedding. */
export function expandItemSummaries(state) {
  if (!Object.hasOwn(state, 'itemEncoding')) return state;
  const encoding = state.itemEncoding;
  /** Refuse malformed wire data rather than inventing item values. */
  function invalid() { throw new TypeError('invalid compact item encoding; request a fresh ordinary board state'); }
  /** Clone every JSON value so rows never share mutable arrays or objects. */
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  /** Define even special JSON keys without invoking prototype setters. */
  function put(row, key, value) { Object.defineProperty(row, key, { value, enumerable: true, writable: true, configurable: true }); }
  if (!encoding || !Array.isArray(state.items)) invalid();
  let items;
  if (encoding.version === 1) {
    if (!encoding.defaults || typeof encoding.defaults !== 'object' || Array.isArray(encoding.defaults)
      || Object.keys(encoding.defaults).some(key => ['id', 'title', '__proto__', 'prototype', 'constructor'].includes(key))) invalid();
    items = state.items.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) invalid();
      return { ...clone(encoding.defaults), ...clone(row) };
    });
  } else if (encoding.version === 2) {
    if (!Number.isSafeInteger(encoding.count) || encoding.count < 2
      || Object.keys(encoding).some(key => !['version', 'count'].includes(key))
      || state.items.length < 2 || state.items.some(column => !Array.isArray(column)
        || column.length !== 4 || !Array.isArray(column[2]) || column[2].length !== encoding.count)) invalid();
    items = Array.from({ length: encoding.count }, () => ({}));
    const keys = new Set(), parents = new Set(), wholes = new Set();
    for (const column of state.items) {
      if (!Array.isArray(column) || column.length !== 4) invalid();
      const [name, mode, data, extra] = column;
      const split = Array.isArray(name);
      if (split ? name.length !== 2 || name.some(part => typeof part !== 'string') : typeof name !== 'string') invalid();
      const path = split ? name : [name], key = path[path.length - 1];
      const identity = JSON.stringify(path);
      if (keys.has(identity) || !Array.isArray(data) || data.length !== items.length) invalid();
      keys.add(identity);
      (split ? parents : wholes).add(path[0]);
      if (split) for (const row of items) if (!Object.hasOwn(row, path[0])) put(row, path[0], {});
      if (!split && parents.has(name) || split && wholes.has(path[0])) invalid();
      if (!['r', 'd', 't'].includes(mode) || !Array.isArray(extra)) invalid();
      const absent = mode === 'r' ? extra : mode === 't' ? extra[1] : [];
      if (!Array.isArray(absent) || absent.some((index, position) => !Number.isSafeInteger(index)
        || index < 0 || index >= items.length || (position > 0 && index <= absent[position - 1]))) invalid();
      if (mode === 't' && (extra.length !== 2 || !Number.isSafeInteger(extra[0]))) invalid();
      const missing = new Set(absent);
      data.forEach((value, index) => {
        if (missing.has(index)) { if (value !== null) invalid(); return; }
        if (mode === 'd') {
          if (!Number.isSafeInteger(value) || value < -1 || value >= extra.length) invalid();
          if (value !== -1) put(split ? items[index][path[0]] : items[index], key, clone(extra[value]));
        } else if (mode === 't') {
          if (value === null) put(split ? items[index][path[0]] : items[index], key, null);
          else {
            if (!Number.isSafeInteger(value) || !Number.isSafeInteger(extra[0] + value)
              || Math.abs(extra[0] + value) > 8640000000000000) invalid();
            put(split ? items[index][path[0]] : items[index], key, new Date(extra[0] + value).toISOString());
          }
        } else put(split ? items[index][path[0]] : items[index], key, clone(value));
      });
    }
  } else invalid();
  for (const row of items) {
    if (!Object.hasOwn(row, 'id') || !Number.isSafeInteger(row.id) || row.id < 1
      || !Object.hasOwn(row, 'title') || typeof row.title !== 'string') invalid();
  }
  const { itemEncoding: _encoding, ...plain } = state;
  return { ...plain, items };
}
