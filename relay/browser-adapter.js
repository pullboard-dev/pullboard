/** Browser implementation of the shared relay request contract [C7]. */
import { createRelayAdapter } from '../packages/kernel/core.js';

export const realRelayAdapter = createRelayAdapter((url, options) => globalThis.fetch(url, options));
