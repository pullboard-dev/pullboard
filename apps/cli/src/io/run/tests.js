#!/usr/bin/env node
/** Launch the test runner engine that gate owns, handing it the landing and runners cells it takes as injected loaders; this app sits above all three, so gate imports neither. */
import { fileURLToPath } from 'node:url';
import { startRunTests } from '../../../../../packages/gate/bin/run-tests.js';

await startRunTests({
  runner: fileURLToPath(import.meta.url),
  services: {
    landing: () => import('../../../../../packages/landing/index.js'),
    runners: () => import('../../../../../packages/runners/index.js'),
    gateSlotServices: () => import('../../../../lib/slot.js'),
  },
});
