/** The real runner provider for test admission, apart from the landing one so no fixture file imports two cells [C7]. */
import { runnerExecutionServices } from '../../../runners/index.js';

export const runnerServices = runnerExecutionServices();
