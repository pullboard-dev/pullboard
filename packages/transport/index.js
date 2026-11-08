/** One reused channel per runner through a runner adapter; gates run there as result files, health is a probe-renewed lease [C7]. */
export { createTransport, sharedTransport, connect, probe, startShard, fetchResult } from './src/shell/transport.js';
export { runGate } from './src/shell/gate-run.js';
export { sshAdapter, spawnSsh, sshControlPath } from './src/shell/ssh.js';
export { pullAdapter, pullStatement } from './src/shell/pull.js';
export { pullServer, pullRunner } from './src/shell/pull-http.js';
export { mintJobToken, readJobToken } from './src/core/pull-token.js';
export { shellWord, channelKey } from './src/core/frames.js';
export { resultDigest, parseResult } from './src/core/result-file.js';
export { probeStanding, QUARANTINE_GAP_MS } from './src/core/quarantine.js';
export { ensureSource } from './src/shell/tree-source.js';
export { ensureTooling, toolingFolder } from './src/shell/tooling-send.js';
