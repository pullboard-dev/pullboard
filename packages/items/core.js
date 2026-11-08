import { VENDOR_FAMILY_ENGINE } from '../../src/vendor-family-engine.js';
export { criterionSize } from './src/core/criterion-size.js';
import { vendorFamilyAliases } from './src/core/vendor-families.js';
import { ENGINE_VERSION } from '../../src/engine-metadata.js';
import { FAMILY_ALIAS_ENGINE } from '../../src/family-alias-engine.js';

/** Index the explicit alias list once: each declared spelling, lowercased, names its canonical family [#1762]. */
export function familyIndex(families) {
  const index = new Map();
  for (const [canonical, aliases] of Object.entries(families ?? {})) {
    for (const name of [canonical, ...aliases]) index.set(name.trim().toLowerCase(), canonical.trim().toLowerCase());
  }
  return index;
}

/** The alias index applies only at or above its engine, so sealed older moves keep the comparison they were recorded under [#1762]. */
export function aliasEngineOn(board) {
  return (board.executionEngineVersion ?? ENGINE_VERSION) >= FAMILY_ALIAS_ENGINE;
}

/** The explicit alias index, or null below its engine so older recorded moves compare as they did [#1762]. */
export function familyAliasesOf(board) {
  if (!aliasEngineOn(board)) return null;
  return (board.executionEngineVersion ?? ENGINE_VERSION) >= VENDOR_FAMILY_ENGINE
    ? vendorFamilyAliases(board.familyAliases) : board.familyAliases ?? null;
}

/** Both families are declared and differ; below the alias engine this is the original raw-label comparison, byte for byte [#1762]. */
export function familiesDiffer(board, first, second) {
  if (!aliasEngineOn(board)) return Boolean(first && second && first !== second);
  const aliases = familyAliasesOf(board);
  const left = familyName(first, aliases), right = familyName(second, aliases);
  return Boolean(left && right && left !== right);
}

/** A declared vendor label is compared as text, never inferred from a model or diagnostic; only the explicit alias index maps spellings to one family. */
export function familyName(value, aliases = null) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const name = value.trim().toLowerCase();
  return aliases?.get(name) ?? name;
}

export { validateCheckTiming, saveCheckTiming, frozenCheckTiming, parseCheckTiming, checkTimingEngine } from './src/core/check-timing.js';
export { NAMEABLE_ORIGINS, carriesOrigin, answerProvenance } from './src/core/decision-origin.js';
export { ITEM_NOTE_KINDS, FACT_KINDS, requireFactKind, itemNotesText } from './src/core/item-notes.js';
export { recordFamilyDeclareActivation, namesFamily, originalSession, derivedFamily, seatFamily, familyDeclareFloor, withDerivedFamily, withDerivedFamilies, withFamilyReads } from './src/shell/family-declaration.js';
export { hasForeignDependencies, localDependencyIds } from './src/core/item-dependencies.js';
export { itemPatchRecords, itemPatches } from './src/shell/item-patch-state.js';
export { outsideSource } from './src/core/outside-source.js';
export { itemPatchPaths } from './src/core/item-patch-paths.js';
export { itemFiles } from './src/core/item-files.js';
export { itemSummary, withListFields } from './src/core/item-list.js';
export { conflictCause, reopenConflictEvidence } from './src/core/reopen-cause.js';
