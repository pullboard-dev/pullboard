/** Actual executor samples shared by local gate and registered worker receipts [C7]. */
import { availableParallelism } from 'node:os';
import { freemem } from 'node:os';
import { hostname } from 'node:os';
import { loadavg } from 'node:os';
import { platform } from 'node:os';

/** Sample this executing machine now, never the controller on behalf of a remote run. */
export function sampleRunnerLoad() {
  return { at: new Date().toISOString(), average: loadavg(), cpus: availableParallelism(), freeMB: Math.floor(freemem() / 1048576) };
}

/** Describe actual local admission capacity; unreported capabilities stay unknown. */
export function localRunnerDescriptor(slots, browser, gui) {
  return { id: `local:${hostname()}`, kind: 'local', slots: { current: slots, limit: slots, elastic: false },
    capabilities: { os: platform(), browser, ...(gui === undefined ? {} : { gui }) } };
}
