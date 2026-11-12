/** The environment every runner job's processes get: runner-owned values, never the host's [C7]. */
import { join } from 'node:path';

/** How many test workers a pulled job may use: its share of the runner's cores, set by the serve that runs it [P7,#5919]. */
export const JOB_WORKERS_ENV = 'PULLBOARD_JOB_WORKERS';

/**
 * A minimal environment from runner-owned values, excluding caller credentials and markers.
 *
 * @param {{ safePath: string, workerId?: string }} S - Job PATH and id.
 * @param {string} home - The job's own HOME.
 * @param {string} temporary - The job's own temp folder.
 * @param {string} [machineHomePath] - PULLBOARD_MACHINE_HOME, if pinned.
 * @param {string} [nodeOptions] - The runner's NODE_OPTIONS preload.
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
