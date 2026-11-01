/** Git identity, committed reads, adapters and publication evidence shared behind legacy shims [C7]. */
export * from "./src/shell/committed-file-reader.js";
export * from "./src/shell/git-adapter.js";
export * from "./src/shell/git-launch-ratchet.js";
export * from "./src/shell/git-memory.js";
export * from "./src/shell/git.js";
export * from "./src/shell/pre-push-receipts.js";
export * from "./src/shell/push-native-evidence.js";
export * from "./src/shell/queued-item-lease.js";
export * from "./src/shell/source-advance-nudge.js";
export * from "./src/shell/trunk-revision.js";
export * from "./src/shell/worktree.js";
export * from "./core.js";
export * from "./src/shell/git-trunk-ref.js";
export { canonicalToolCommand, recordToolCommand, recordedToolCommits, toolRegenerationSource } from './src/shell/tool-commands.js';
