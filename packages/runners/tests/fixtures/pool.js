import { listResources } from '../../../resources/index.js';

/** Read the real machine queue from the fixture pool while preserving this test process's environment. */
export function focusedPoolSnapshot(machine) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machine;
  try { return listResources({ scope: 'machine' }).find((resource) => resource.name === 'gate'); }
  finally {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
  }
}
