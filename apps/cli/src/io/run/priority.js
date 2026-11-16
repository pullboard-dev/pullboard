import { setPriority as osSetPriority } from 'node:os';

/** The scheduling priority (nice value) a test process takes with gate.testNice on; 10 is the ordinary background nice. */
export const TEST_NICE = 10;

/**
 * Lower one process's scheduling priority when gate.testNice is on, and leave it alone when off.
 * Why: test processes loaded the board's machine to load 128 and descheduled board writers that held the write lock;
 * children inherit the value, so lowering the runner lowers every test process it starts [C7,#8509].
 *
 * @param {number} pid - The process to lower; 0 is the caller.
 * @param {{ enabled: boolean, setPriority?: (pid: number, priority: number) => void }} options - enabled is config's testNiceEnabled().
 * @returns {boolean} Whether the priority was lowered; a refused change (no permission, no such process) leaves it as it was.
 */
export function lowerTestPriority(pid, { enabled, setPriority = osSetPriority }) {
  if (!enabled) return false;
  try { setPriority(pid, TEST_NICE); return true; } catch { return false; }
}
