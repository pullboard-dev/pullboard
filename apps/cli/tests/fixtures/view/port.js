/** Coordinate tests that must bind the same physical loopback port [N26,C7]. */
import { createServer } from 'node:net';
import { takeResource } from '../../../../../packages/resources/index.js';
import { DEFAULT_VIEW_PORT } from '../../../../../packages/config/index.js';

/** Ask the OS for a currently unused loopback port, excluding the user's fixed default. */
export async function chooseViewPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port === DEFAULT_VIEW_PORT ? chooseViewPort() : port;
}

/** Take a machine-wide lease for a selected view port, independent of private test homes. */
export async function takeDefaultViewPort(root, options = {}) {
  const { port = await chooseViewPort(), ...resourceOptions } = options;
  const privateMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  delete process.env.PULLBOARD_MACHINE_HOME;
  let leasePromise;
  try {
    // takeResource reads machineHome synchronously before its first await, so restoring now
    // keeps other asynchronous fixture work from observing the account-wide resource pool.
    leasePromise = takeResource({ ...resourceOptions, name: `view-port-${port}`, capacity: 1, scope: 'machine', root });
  } finally {
    if (privateMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = privateMachineHome;
  }
  const lease = await leasePromise;
  return { ...lease, port };
}
