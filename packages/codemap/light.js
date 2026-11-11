/** Pure codemap helpers usable without loading the cell lint tooling [C7,CD60,CD64]. */
export { isDefaultTestFile } from './src/logic/discovery.js';
export { rootAllowed, strayNextStep } from './src/logic/allowlist.js';
export { shimCountProblems } from './src/logic/ratchet.js';
export { compareItemFunctions } from './src/logic/functions.js';
export { importsIn, cpuLiteralCache, cpuRegistrationExportsIn, cpuCallableExportsIn, cpuLoadOptionsIn } from './src/io/module/imports.js';
export { readPathMap } from './src/logic/path/map.js';
export { narrowedTo } from './src/io/check-walk.js';
export { readText } from './src/io/check-walk.js';
export { TEST_FILE } from './src/io/check-walk.js';
export { walk } from './src/io/check-walk.js';
