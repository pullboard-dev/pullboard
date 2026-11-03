#!/usr/bin/env node
/** Compose native timeout custody without a lower gate import into the app runner [C7,E27]. */
import { createDescendantTracker } from '../src/runner-custody.js';
import { runTimedShell } from '../src/timed-shell-worker.js';

await runTimedShell({ createDescendantTracker });
