/** Code map, path map and cell lint tooling behind one front door [C7,CD60,CD64]. */
export * from './src/shell/cell-binding-uses.js';
export * from './src/shell/cell-lint-baseline-plan.js';
export * from './src/shell/cell-lint-inventory.js';
export * from './src/shell/cell-lint-ratchet.js';
export * from './src/shell/cell-lint-store.js';
export { mainCommit, mainCellLintReport } from './src/shell/main-cell-lints.js';
export * from './src/shell/cell-lints.js';
export { ROOT_FILES, ROOT_FOLDERS, rootAllowed, strayNextStep } from './src/core/root-allowlist.js';
export * from './src/core/cells-plan-cuts.js';
export * from './src/shell/cells-plan.js';
export { cachedCellsRun, cellsCacheEnabled, cellsStateKey } from './src/shell/cells-cache.js';
export * from './src/shell/code-map.js';
export * from './src/core/import-map.js';
export * from './src/core/path-map-operands.js';
export * from './src/core/path-map.js';
export * from './src/shell/source-advance-plan.js';
export * from './src/shell/source-inventory.js';
export * from './src/shell/cell-lint-cell-shards.js';
export * from './src/shell/map-slice-say.js';
export { isDefaultTestFile } from './src/core/default-test-file.js';
export { withCellLintParser } from './src/shell/cell-parser.js';

export { shimImportProblems, stagedShimImportProblems } from './src/shell/shim-import-ratchet.js';

export { shimCountProblems, shimCountBaseline } from './src/core/shim-count-ratchet.js';
export { shimLifecycle } from './src/shell/shim-lifecycle.js';
export { predictItemFunctions, compareItemFunctions } from './src/core/item-functions.js';

export { createFixtureMemo } from './src/shell/cells-fixture-memo.js';
export { acceptedInventoryKey, acceptedInventoryRuntimeIdentity, readAcceptedInventory, validateAcceptedInventory, warmAcceptedInventory } from './src/shell/accepted-inventory-cache.js';
export { cellExistsSync, cellLstatSync, cellReadFileSync, cellReaddirSync, cellSourceSnapshot, withCellSourceSnapshots } from './src/shell/cell-source-snapshot.js';
