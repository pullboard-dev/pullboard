/** Build the runner-owned child environment and bind the trusted resource API and its pools [C7]. */
import { Refused } from '../../../../../packages/kernel/light.js';
import * as resourceApi from '../../../../../packages/resources/light.js';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Construct a minimal environment from runner-owned values, excluding caller credentials and markers. */
function childEnvironment(S, home, temporary, machineHomePath = '', nodeOptions = '') {
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

/** Add this worker's remote gate lease so nested test runners reuse the remote slot instead of deadlocking. */
export function scopedEnvironment(S, home, temporary, machineHomePath, gateLease, resourcesApi, nodeOptions = '') {
  return {
    ...childEnvironment(S, home, temporary, machineHomePath, nodeOptions),
    ...resourcesApi.gateSlotEnvironment(gateLease),
  };
}

/** Check that this already installed capsule matches the controller before using its static API. */
export function loadResourceApi(runtime) {
  const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  if (Object.entries(runtime.files).some(([name, source]) => readFileSync(join(sourceDirectory, name), 'utf8') !== source)) {
    throw new Error('trusted runtime cache does not match the request');
  }
  return resourceApi;
}

/** Select only the explicit pool while acquiring its lease; restore the worker environment afterward. */
export async function acquireResourceApi(api, options, machineHomePath) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machineHomePath;
  try { return await api.takeResource(options); }
  finally {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
  }
}

/**
 * Size this machine's gate and browser pools to the capacity the controller registered, carried in
 * the job (#1066). A lower registration waits for an idle pool, and is refused by name until then.
 */
export function registeredCapacity(api, spec, root, machineHomePath) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machineHomePath;
  try {
    /** Set one pool row to the board's registered capacity, refusing only an unsafe active-holder overflow. */
    const size = (name, capacity) => {
      try { return api.setResourceCapacity({ name, capacity, scope: 'machine', root, allowSafeDecrease: true }).capacity; }
      catch (error) {
        if (error?.code !== 'RESOURCE_BUSY') throw error;
        throw new Refused('RUNNER_CAPACITY_BUSY', `this runner is registered with ${capacity} ${name} slot(s), but its worker pool cannot shrink from its current capacity safely: ${error.message}`);
      }
    };
    // A runner registered with no browsers never receives a browser run, so its browser row is left alone.
    return { gateCapacity: size('gate', spec.slots), browserCapacity: spec.browser > 0 ? size('browser', spec.browser) : 1 };
  } finally {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
  }
}
