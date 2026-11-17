import { loadMachineSettings } from '../../logic/settings.js';

/**
 * Whether browser-free check admission is on for this machine; it is deliberately opt-in.
 * Why its own file: the config light door reaches it without loading the whole settings module, which pulls the
 * resources, queue and kernel front doors into the runner worker closure [C7,CD60].
 *
 * @returns {boolean}
 */
export function browserFreeChecksEnabled() {
  return loadMachineSettings().gate?.browserFreeChecks === true;
}
