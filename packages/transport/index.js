/** One reused channel per runner through a runner adapter, shards as result files on the runner, a probe apart [C7]. */
export { createTransport, sharedTransport, connect, probe, startShard, fetchResult } from './src/shell/transport.js';
export { sshAdapter } from './src/shell/ssh.js';
export { shellWord, channelKey } from './src/core/frames.js';
export { resultDigest, parseResult } from './src/core/result-file.js';
