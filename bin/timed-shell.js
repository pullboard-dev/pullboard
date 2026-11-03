#!/usr/bin/env node
/** Compose native timeout custody; this executable belongs to the runner app, so it imports the app's front door directly [C7,E27]. */
import { createDescendantTracker } from '../apps/runner/index.js';
import { runTimedShell } from '../src/timed-shell-worker.js';

await runTimedShell({ createDescendantTracker });
