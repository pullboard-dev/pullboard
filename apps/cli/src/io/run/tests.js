#!/usr/bin/env node
/** Launch the test runner engine that gate owns, handing it the landing and runners cells it takes as injected loaders; this app sits above all three, so gate imports neither. */
import { fileURLToPath } from 'node:url';
import { testNiceEnabled } from '../../../../../packages/config/index.js';
import { lowerTestPriority } from './priority.js';
import { startRunTests } from '../../../../../packages/gate/bin/run-tests.js';

// Lowered before any test process starts, so every child inherits it; unreadable settings leave the priority alone.
lowerTestPriority(0, { enabled: (() => { try { return testNiceEnabled(); } catch { return false; } })() });
await startRunTests({
  runner: fileURLToPath(import.meta.url),
  services: {
    landing: () => import('../../../../../packages/landing/index.js'),
    runners: () => import('../../../../../packages/runners/index.js'),
    gateSlotServices: () => import('../../../../lib/slot.js'),
  },
});
