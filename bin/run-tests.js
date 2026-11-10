#!/usr/bin/env node
/** Launch the test runner engine that gate owns; this file only names itself and hands in the cells above gate. */
import { fileURLToPath } from 'node:url';
import { startRunTests } from '../packages/gate/bin/run-tests.js';

await startRunTests({
  runner: fileURLToPath(import.meta.url),
  services: {
    landing: () => import('../packages/landing/index.js'),
    runners: () => import('../src/runners.js'),
    gateSlotServices: () => import('./gate-slot-services.js'),
  },
});
