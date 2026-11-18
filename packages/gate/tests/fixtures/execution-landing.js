/** The real landing provider for test admission, apart from the runner one so no fixture file imports two cells [C7]. */
import { landingExecutionServices } from '../../../landing/index.js';

export const landingServices = landingExecutionServices();
