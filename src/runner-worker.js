/** The pinned process entry of the runner worker; its bytes, not the body's, prove the tooling identity [C7]. */
import { runnerWorker } from '../apps/runner/index.js';

runnerWorker(process.argv);
