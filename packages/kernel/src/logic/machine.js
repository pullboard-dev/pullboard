import { join } from 'node:path';
import { resolve } from 'node:path';

/** The machine home from explicit inputs; one rule below the parse cache, gate and runners [C7]. */
export function machineHome({ override, accountHome, osHome }) {
  return override ? resolve(override) : join(resolve(accountHome || osHome), '.pullboard');
}
