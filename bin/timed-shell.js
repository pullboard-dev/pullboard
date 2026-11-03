#!/usr/bin/env node
/** Compose native timeout custody through a runner port: the app front door is loaded at the composition root [C7,E27]. */
import { runTimedShell } from '../src/timed-shell-worker.js';

const { createDescendantTracker } = await import('../apps/runner/index.js');
await runTimedShell({ createDescendantTracker });
