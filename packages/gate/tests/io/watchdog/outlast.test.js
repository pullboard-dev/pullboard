/** Output children outlive many idle windows in watch and coverage while a quiet peer still stops [C7,V10]. */
import { test } from 'node:test';
import { runLegacy } from '../../fixtures/watchdog/legacy.js';

// The fixture injects a 3 s idle window, so 12 s of output spans four windows; a fixed two-minute wait proved nothing more and set the proof floor (#5811).
const OUTPUT_MS = 12_000;

test('output children that outlast four idle windows stay alive in watch and coverage while quiet peers stop [C7,V10]', async t => {
  await Promise.all([runLegacy(t, 'coverage', OUTPUT_MS), runLegacy(t, 'watch', OUTPUT_MS)]);
});
