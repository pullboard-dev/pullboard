/**
 * Preloaded with --import into a measured child process: when the child exits it writes its own CPU time (user plus system, in microseconds) to file descriptor 3 [C7].
 * Why: a child's wall time grows with runner load, its CPU time barely does, so the startup rows can be judged where load does not reach.
 */
import { writeSync } from 'node:fs';

process.on('exit', () => {
  try { const { user, system } = process.cpuUsage(); writeSync(3, String(user + system)); } catch { /* the parent did not open descriptor 3, so nothing listens */ }
});
