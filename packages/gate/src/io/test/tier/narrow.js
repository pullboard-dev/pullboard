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
 * @param {{ mode?: unknown, select: () => { full?: boolean, files?: string[] } | null | undefined, canary?: string[] }} options
 * @returns {object | null} the tier selection with narrowed units and `owedFiles`, or null to keep it as is
 */
export function narrowConfinedTiers(testTiers, { mode, select, canary = [] }) {
  if (mode !== 'tests' && mode !== 'all') return null;
  const roots = testTiers?.confinedRoots;
  if (!Array.isArray(roots) || !roots.length || !Array.isArray(testTiers.units)) return null;
  const inFolder = file => roots.some(cell => file.startsWith(`${cell}/tests/`));
  const changed = testTiers.changed ?? [];
  if (mode === 'tests' && (!changed.length || !changed.every(inFolder))) return null;
  let selected;
  try { selected = select(); } catch { return null; }
  if (!selected || selected.full === true || !Array.isArray(selected.files)) return null;
  const keep = new Set([...selected.files, ...changed, ...canary]);
  const owedFiles = testTiers.units.filter(file => inFolder(file) && !keep.has(file)).sort();
  if (!owedFiles.length) return null;
  const dropped = new Set(owedFiles);
  return { ...testTiers, units: testTiers.units.filter(file => !dropped.has(file)), owedFiles };
}
