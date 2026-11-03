/** Board move declarations, their registry and the bar-ready setting behind one front door [C7,CD60,CD64]. */
export * from "./src/core/bar-ready-setting.js";
export * from "./src/shell/move-registry.js";
export { default as reopen } from "./src/core/moves/reopen.js";
export { default as shout } from "./src/core/moves/shout.js";
export { default as submit } from "./src/core/moves/submit.js";
export { default as verify } from "./src/core/moves/verify.js";
export { default as finishLandingBatch } from "./src/core/moves/finishLandingBatch.js";
export { default as release } from "./src/core/moves/release.js";
export { default as recordGateRun } from "./src/core/moves/recordGateRun.js";
