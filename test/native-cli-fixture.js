/** Compose the real native board for in-process CLI tests [C7]. */
import { main as cliMain } from '../src/cli-main.js';
import { HOOK_WORKER } from '../src/cli-hook-work.js';
import { launchRelaySender } from '../src/relay-sender-main.js';

/** Run the production CLI with the same explicit native capability as its process entry. */
export function main(argv, streams) {
  return cliMain(argv, { ...streams, hookWorker: HOOK_WORKER, launchRelaySender, loadNativeBoard: () => import('../src/native-board.js') });
}
