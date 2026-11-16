/** One reused channel per runner through a runner adapter; gates run there as result files, health is a probe-renewed lease [C7]. */
export { createTransport, sharedTransport, connect, probe, startShard, fetchResult } from './src/io/main.js';
export { dispatchGate } from './src/io/gate.js';
export { sshAdapter, spawnSsh, sshControlPath } from './src/io/ssh.js';
export { pullAdapter, pullStatement, saveKeyedResult } from './src/io/pull.js';
export { pullServer, pullRunner } from './src/io/pull/http.js';
export { fileStore } from './src/io/pull/store.js';
export { boardPullAdapter, PULL_STORE_FILE } from './src/io/pull/board.js';
export { issueRunnerKey, revokeRunnerKey, trustedRunnerKeys, revokedRunnerNames, RUNNER_KEYS_FILE } from './src/io/pull/keys.js';
export { mintJobToken, readJobToken } from './src/logic/token.js';
export { shellWord, channelKey } from './src/logic/frames.js';
export { resultDigest, parseResult } from './src/logic/result.js';
export { probeStanding, QUARANTINE_GAP_MS } from './src/logic/quarantine.js';
export { ensureSource } from './src/io/tree.js';
export { ensureTooling, toolingFolder } from './src/io/tooling.js';
