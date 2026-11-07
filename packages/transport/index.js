/** One reused connection per runner, shared by every gate on it, with a probe apart from the channel [C7]. */
export { createTransport, sharedTransport, connect, probe } from './src/shell/transport.js';
export { shellWord, channelKey } from './src/core/frames.js';
