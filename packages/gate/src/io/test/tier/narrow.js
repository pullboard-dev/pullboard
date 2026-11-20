/**
 * Narrow a confined cell's tier units to the ones the import graph reaches from the change [C7].
 *
 * Why: a change confined to one sealed cell selected every test under that cell's tests folder, so a four-line data
 * edit ran 285 files in 29 shards. The repo key confinedImportSelection, read from accepted main, lets submit keep only
 * the cell tests the import graph reaches, the changed tests and the canary. The dropped files are named in `owedFiles`:
 * landing runs the whole confined cell on the exact merged tree, never on this narrowed proof (RFC 0006/0007 A3, A6;
 * RFC 0011 V37). Every doubt keeps the whole folder: a key that is off, a change outside a cell's tests folder under
 * "tests" (production code reads data files by path, which the import graph cannot see), a full selection, or a throw.
 *
 * @param {{ units: string[], confinedRoots?: string[], changed?: string[] } | null} testTiers - the tier selection
 * @param {{ mode?: unknown, select: (changed?: string[]) => { full?: boolean, files?: string[] } | null | undefined, canary?: string[], read?: (file: string) => string | null }} options
 * @returns {object | null} the tier selection with narrowed units and `owedFiles`, or null to keep it as is
 */
export function narrowConfinedTiers(testTiers, { mode, select, canary = [], read = () => null }) {
  if (mode !== 'tests' && mode !== 'all') return null;
  const roots = testTiers?.confinedRoots;
  if (!Array.isArray(roots) || !roots.length || !Array.isArray(testTiers.units)) return null;
  const inFolder = file => roots.some(cell => file.startsWith(`${cell}/tests/`));
  const changed = testTiers.changed ?? [];
  if (mode === 'tests' && (!changed.length || !changed.every(inFolder))) return null;
  let selected;
  // The import graph cannot read a registry record, so a test-and-record change selects from its test files and the record's readers are named by recordCompanions [C7].
  const withRecord = recordChange(changed);
  try { selected = withRecord ? select(changed.filter(file => !RECORD.test(file))) : select(); } catch { return null; }
  if (!selected || selected.full === true || !Array.isArray(selected.files)) return null;
  const keep = new Set([...selected.files, ...changed, ...canary, ...withRecord ? recordCompanions(testTiers.units, changed, roots, read) : []]);
  const owedFiles = testTiers.units.filter(file => inFolder(file) && !keep.has(file)).sort();
  if (!owedFiles.length) return null;
  const dropped = new Set(owedFiles);
  return { ...testTiers, units: testTiers.units.filter(file => !dropped.has(file)), owedFiles };
}

const RECORD = /\/tests\/fixtures\/registry[^/]*\.json$/u;
const COMPANION = /\/tests\/(?:registry|inputs|stable)\.test\.js$/u;
const HEADER_LINE = /^\s*(?:\/\*|\*|\/\/|$)/u;
const HEADER_NAMES = /@pullboard-test-(?:reads|loads)\s+(\S+)/u;

/** Whether a change carries a cell test file and a registry record. */
function recordChange(changed) { return changed.some(file => RECORD.test(file)) && changed.some(file => /\.test\.js$/u.test(file)); }

/** The paths a test names in its leading comment lines with a reads or loads tag; later code never counts. */
function headerNames(source) {
  const names = [];
  for (const line of source.split('\n')) {
    if (!HEADER_LINE.test(line)) break;
    const match = HEADER_NAMES.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * The cell tests a test-only change with a registry record keeps besides its import graph: the cell's registry, inputs and
 * stable tests, which check records and inputs by path, and every test whose header names a changed file [C7].
 */
function recordCompanions(units, changed, roots, read) {
  const inRoot = file => roots.some(cell => file.startsWith(`${cell}/tests/`));
  const touched = new Set(changed);
  return units.filter(file => inRoot(file) && (COMPANION.test(file) || headerNames(read(file) ?? '').some(name => touched.has(name))));
}
