#!/usr/bin/env node
/** Launch the test runner engine that gate owns; this file only names itself and hands in the cells above gate. */
import { fileURLToPath } from 'node:url';
import { startRunTests } from '../../../bin/run-tests.js';

await startRunTests({
  runner: fileURLToPath(import.meta.url),
  services: {
    landing: () => import('../../../../landing/index.js'),
    runners: () => import('../../../../runners/index.js'),
    gateSlotServices: () => import('../slot/services.js'),
  },
});
