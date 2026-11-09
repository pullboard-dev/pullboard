import { join } from 'node:path';
import { resolve } from 'node:path';

/**
 * Resolve a machine home from explicit account and environment inputs.
 * Why: the parse cache, the gate and the runners all key their machine state off one rule, so it lives below all of them [C7].
 */
export function machineHome({ override, accountHome, osHome }) {
  return override ? resolve(override) : join(resolve(accountHome || osHome), '.pullboard');
}
