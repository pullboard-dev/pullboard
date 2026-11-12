/** The environment a runner gives every job's processes: runner-owned values only, never the runner service's own [C7]. */
import { join } from 'node:path';

/**
 * Construct a minimal environment from runner-owned values, excluding caller credentials and markers.
 * Why: a job inherits nothing of the host's HOME, ~/.pullboard or shared temp folder, on a pushed or a pulled runner alike.
 *
 * @param {{ safePath: string, workerId?: string }} S - PATH for the job and its job id.
 * @param {string} home - The job's own HOME.
 * @param {string} temporary - The job's own temp folder.
 * @param {string} [machineHomePath] - PULLBOARD_MACHINE_HOME, when the runner pins one.
 * @param {string} [nodeOptions] - The runner's own NODE_OPTIONS preload.
 * @returns {Record<string, string>}
 */
export function childEnvironment(S, home, temporary, machineHomePath = '', nodeOptions = '') {
  return {
    PATH: S.safePath,
    HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    LANG: process.env.LANG || 'C.UTF-8',
    TZ: process.env.TZ || 'UTC',
    CI: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    NPM_CONFIG_USERCONFIG: join(home, 'npm-userconfig'),
    NPM_CONFIG_GLOBALCONFIG: join(home, 'npm-globalconfig'),
    // The spawn-journal preload is declared so a test's NODE_OPTIONS classifier knows it is the runner's own.
    ...(nodeOptions ? { NODE_OPTIONS: nodeOptions, PULLBOARD_RUNNER_PRELOAD: nodeOptions } : {}),
    ...(machineHomePath ? { PULLBOARD_MACHINE_HOME: machineHomePath } : {}),
    // Marks every process of this job, so the CLI never starts a detached watcher that outlives it (#2513).
    PULLBOARD_RUNNER_JOB: String(S.workerId || 'job'),
  };
}
