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
export { PLAN_DIR, PLAN_FILE, SEED_FILE, computePlan, planWrites, placePath, readPlan, readSeed, shardFile, writePlan } from './src/shell/cells-plan-model.js';
export { formatJson } from './src/core/format-json.js';
export { entryPlacementProblems as planEntryProblems, ownedStayProblems, processEntry, retiredProblems } from './src/shell/cells-plan-placement.js';
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

export { engineStayTransition, retainEnginePaths } from './src/shell/cells-engine-stays.js';
export { createMoveTool } from './src/shell/cells-move-transaction.js';
export { fixtureSourceEdits } from './src/shell/cells-move-fixtures.js';
export { readMoveDataReads, staleDataReads } from './src/shell/cells-data-reads.js';
export { createFixtureMemo } from './src/shell/cells-fixture-memo.js';
export { acceptedInventoryKey, acceptedInventoryRuntimeIdentity, readAcceptedInventory, validateAcceptedInventory, warmAcceptedInventory } from './src/shell/accepted-inventory-cache.js';
export { cellExistsSync, cellLstatSync, cellReadFileSync, cellReaddirSync, cellSourceSnapshot, withCellSourceSnapshots } from './src/shell/cell-source-snapshot.js';
export { moveDeclarationFiles, runnerWorkerFiles } from './src/shell/cells-move-closure.js';
export { withParseScope, importsIn, commonJsIn, compileModules, moduleCompiles, cpuLiteralCache, cpuRegistrationExportsIn, cpuCallableExportsIn, cpuLoadOptionsIn } from './src/shell/module-imports.js';
export { importParseScopes } from './src/shell/module-import-cache-state.js';
export { LAYOUT_RULES, layoutCounts, layoutRatchet, layoutViolations } from './src/core/layout.js';
export { layoutCheck, layoutReport, layoutWrite } from './src/shell/layout-check.js';
export { cachedMainFact, mainFactDigest, mainFactToolIdentity } from './src/shell/main-facts-cache.js';
export { narrowedTo, readText, TEST_FILE, walk } from './src/shell/check-walk.js';
export { assumptionCounts, assumptionProblems, assumptionsIn, writeAssumptionBaseline } from './src/shell/no-runtime-assumptions.js';
export { leasedModules, syncCallsIn, syncSpawnConfig, syncSpawnProblems, syncSpawnReport, writeSyncSpawnBaseline } from './src/shell/sync-spawn-in-leases.js';
