/** Conservative, deterministic row merges for the two authoritative generated manifests [C7,D3]. */
const FIELDS = {
  'packages/codemap/data/plan/cells.json': ['cells', 'stays', 'entries', 'retired', 'engineStays'],
  'packages/gate/data/tests/tiers.json': ['files'],
};
const ABSENT = Symbol('absent');

/** Identify the exact data-only paths allowed during source composition. */
export function rowManifest(path) { return Object.hasOwn(FIELDS, path); }

// The plan's per-cell shards and its data-read files: plain JSON data a conflict may merge by entry [C7,D3].
const PLAN_DATA = /^packages\/codemap\/data\/plan\/(?:[a-z0-9-]+|data-reads\/[a-z0-9:-]+)\.json$/u;

/** True for a path whose conflict may merge by entry wherever main is composed: the row manifests and the plan data files. */
export function mergeableData(path) { return rowManifest(path) || PLAN_DATA.test(path); }

/** Ignore JSON object key order without changing array order or conflating absence with null. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** Compare recorded values without invoking candidate code. */
function equal(left, right) {
  if (left === ABSENT || right === ABSENT) return left === right;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Preserve a one-sided edit or deletion, but never combine competing edits to one row. */
function choice(base, left, right) {
  if (equal(left, right)) return { value: left };
  if (equal(base, left)) return { value: right };
  if (equal(base, right)) return { value: left };
  return { conflict: true };
}

/** Each manifest declares its row identity explicitly, independently of JSON property order. */
function rowKey(field, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const key = field === 'cells' ? row.name : field === 'files' ? row.file : (field === 'retired' || field === 'engineStays') ? row.row?.[0] : row.path;
  return typeof key === 'string' && key.length ? key : null;
}

/** Refuse malformed or duplicate identities instead of silently dropping a contributor's row. */
function rowMap(field, rows, conflicts) {
  const result = new Map();
  if (!Array.isArray(rows)) { conflicts.push(field); return result; }
  for (const row of rows) {
    const key = rowKey(field, row);
    if (key === null || result.has(key)) conflicts.push(`${field}:${key ?? 'invalid row'}`);
    else result.set(key, row);
  }
  return result;
}

/** Merge whole keyed rows; removal beats an unchanged row, while removal versus edit refuses. */
function mergeRows(field, values, conflicts) {
  const maps = values.map(value => rowMap(field, value === ABSENT ? [] : value, conflicts));
  const keys = [...new Set(maps.flatMap(map => [...map.keys()]))].sort();
  const rows = [];
  for (const key of keys) {
    const selected = choice(...maps.map(map => map.has(key) ? map.get(key) : ABSENT));
    if (selected.conflict) conflicts.push(`${field}:${key}`);
    else if (selected.value !== ABSENT) rows.push(canonical(selected.value));
  }
  if (field === 'cells') rows.sort((left, right) => left.order - right.order || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return rows;
}

/** Keep each manifest row on one line, including long test-tier rows, with stable surrounding JSON. */
function formatManifest(value, fields) {
  const keys = Object.keys(value).sort((left, right) => left === right ? 0 : left === 'version' ? -1 : right === 'version' ? 1 : left < right ? -1 : 1);
  const lines = keys.map(key => {
    const entry = value[key];
    const source = fields.includes(key) && entry.length
      ? `[\n${entry.map(row => '    ' + JSON.stringify(row)).join(',\n')}\n  ]`
      : JSON.stringify(entry, null, 2).replace(/\n/gu, '\n  ');
    return `  ${JSON.stringify(key)}: ${source}`;
  });
  return `{\n${lines.join(',\n')}\n}\n`;
}

/** Merge only version-one authoritative manifests, reporting the exact conflicting field or row. */
export function mergeManifestRows(path, ancestor, ours, theirs) {
  if (!rowManifest(path)) return null;
  const fields = FIELDS[path];
  try {
    const values = [ancestor, ours, theirs].map(source => JSON.parse(source, (_key, value) => {
      if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error('unsafe JSON number');
      return value;
    }));
    if (values.some(value => value?.version !== 1 || Array.isArray(value))) return { conflicts: ['version'] };
    const keys = [...new Set(values.flatMap(value => Object.keys(value)))].sort();
    const merged = Object.create(null), conflicts = [];
    for (const key of keys) {
      const entries = values.map(value => Object.hasOwn(value, key) ? value[key] : ABSENT);
      if (fields.includes(key)) merged[key] = mergeRows(key, entries, conflicts);
      else {
        const selected = choice(...entries);
        if (selected.conflict) conflicts.push(key);
        else if (selected.value !== ABSENT) merged[key] = canonical(selected.value);
      }
    }
    return conflicts.length ? { conflicts: [...new Set(conflicts)].sort() }
      : { source: formatManifest(merged, fields), keys };
  } catch { return { conflicts: ['invalid JSON'] }; }
}
