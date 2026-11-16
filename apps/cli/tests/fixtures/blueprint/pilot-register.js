/** @pullboard-module-loads apps/cli/tests/fixtures/blueprint/pilot-hooks.js */
/** Registers pilot-hooks.js for the process that imports it (node --import), and so for every child that inherits NODE_OPTIONS [C7]. */
import { register } from 'node:module';

register('./pilot-hooks.js', import.meta.url);
