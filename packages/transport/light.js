/** Transport light door: only the ssh spawner and standing probe the runner worker loads; the cell index stays for the controller side [C7]. */
export { spawnSsh } from './src/io/ssh.js';
export { probeStanding } from './src/logic/quarantine.js';
