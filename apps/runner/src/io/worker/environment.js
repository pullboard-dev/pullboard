/** Build the runner-owned child environment and bind the trusted resource API and its pools [C7]. */
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { childEnvironment } from '../../../../../packages/kernel/light.js';
import { Refused } from '../../../../../packages/kernel/light.js';
import * as resourceApi from '../../../../../packages/resources/light.js';
import { once } from 'node:events';
import { delimiter } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

const CLI_NAME = 'pullboard';
// This worker's installed Pullboard root, the folder holding packages/items; the gate bootstrap judges a main that is not Pullboard's tree with it (#6265).
const RUNNER_TOOLS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

/**
 * Put the job checkout's CLI first on PATH as `pullboard`, so a fixture never runs an older global install (11 Nov),
 * and name the runner's shared cache, which every job's keyed caches outlive a job in (#8233). The job's folder holds
 * `checkout` and `tmp`; the link resolves once the history is received. Any other temporary folder is left alone.
 */
function withCheckoutCli(env, temporary) {
  const jobDirectory = dirname(temporary);
  const checkout = join(jobDirectory, 'checkout');
  if (!fs.exists(checkout)) return env;
  const bin = join(jobDirectory, 'cli-bin');
  fs.mkdir(bin, { recursive: true, mode: 0o700 });
  fs.symlink(join(checkout, 'apps/cli/pullboard.js'), join(bin, CLI_NAME));
  const cache = join(jobDirectory, '../../shared-cache');
  fs.mkdir(cache, { recursive: true, mode: 0o700 });
  return { ...env, PULLBOARD_RUNNER_SHARED_CACHE: cache, PATH: [bin, env.PATH].filter(Boolean).join(delimiter) };
}

/** Add this worker's remote gate lease so nested test runners reuse the remote slot instead of deadlocking. */
export function scopedEnvironment(S, home, temporary, machineHomePath, gateLease, resourcesApi, nodeOptions = '') {
  return withCheckoutCli({
    ...childEnvironment(S, home, temporary, machineHomePath, nodeOptions),
    ...resourcesApi.gateSlotEnvironment(gateLease),
    PULLBOARD_RUNNER_TOOLS: RUNNER_TOOLS,
  }, temporary);
}

/** Check that this already installed capsule matches the controller before using its static API. */
export function loadResourceApi(runtime) {
  const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  if (Object.entries(runtime.files).some(([name, source]) => fs.readFile(join(sourceDirectory, name), 'utf8') !== source)) {
    throw new Error('trusted runtime cache does not match the request');
  }
  return resourceApi;
}

/** Select only the explicit pool while acquiring its lease; restore the worker environment afterward. */
export async function acquireResourceApi(api, options, machineHomePath) {
  const env = environmentAdapter();
  const previous = env.get('PULLBOARD_MACHINE_HOME');
  env.set('PULLBOARD_MACHINE_HOME', machineHomePath);
  try { return await api.takeResource(options); }
  finally {
    if (previous === undefined) env.delete('PULLBOARD_MACHINE_HOME');
    else env.set('PULLBOARD_MACHINE_HOME', previous);
  }
}

/**
 * Size this machine's gate and browser pools to the capacity the controller registered, carried in
 * the job (#1066). A lower registration waits for an idle pool, and is refused by name until then.
 */
export function registeredCapacity(api, spec, root, machineHomePath) {
  const env = environmentAdapter();
  const previous = env.get('PULLBOARD_MACHINE_HOME');
  env.set('PULLBOARD_MACHINE_HOME', machineHomePath);
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
    if (previous === undefined) env.delete('PULLBOARD_MACHINE_HOME');
    else env.set('PULLBOARD_MACHINE_HOME', previous);
  }
}
