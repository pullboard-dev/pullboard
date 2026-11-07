/** One reused channel per runner through a runner adapter; gates run there as result files, health is a probe-renewed lease [C7]. */
export { createTransport, sharedTransport, connect, probe, startShard, fetchResult } from './src/shell/transport.js';
export { runGate } from './src/shell/gate-run.js';
export { sshAdapter } from './src/shell/ssh.js';
export { shellWord, channelKey } from './src/core/frames.js';
export { resultDigest, parseResult } from './src/core/result-file.js';
