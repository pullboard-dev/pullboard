#!/usr/bin/env node
/** Compose the fresh native runner controller with its fixed private-check policy, never request-selected code [C7,V4]. */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serveRunnerController } from '../src/runners.js';
import { privateCheckEnvelope } from '../src/runner-private-mode.js';
import { privateCheckPhases } from '../src/runner-private-mode.js';

/** Importing this module never starts a controller; only its exact direct entry accepts bridge input. */
function isRunnerControllerEntry() {
  if (process.argv[2] !== '--pullboard-runner-controller' || !process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isRunnerControllerEntry()) serveRunnerController({ privateCheckEnvelope, privateCheckPhases })
  .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
