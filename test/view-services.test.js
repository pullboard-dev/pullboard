/** The view requires actual higher-level services before opening transports or writing exports [N26,C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli-main.js';
import { cockpitPage } from '../src/cockpit.js';
import { exportView } from '../src/serve.js';
import { serveView } from '../src/serve.js';

/** Match a required service refusal without accepting unrelated setup or transport failures. */
function missingService(name) {
  return error => error.code === 'VIEW_SERVICE_REQUIRED' && error.message.includes(name);
}

test('a live view refuses missing command or renderer services before listening [N26,C7]', async () => {
  await assert.rejects(serveView(), missingService('runCommand'));
  await assert.rejects(serveView({ runCommand: main }), missingService('renderPage'));
  await assert.rejects(serveView({ renderPage: cockpitPage }), missingService('runCommand'));
});

test('an export refuses missing services before reading a board or writing output [N26,C7]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-view-services-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'snapshot');
  await assert.rejects(exportView(directory, output), missingService('runCommand'));
  await assert.rejects(exportView(directory, output, { runCommand: main }), missingService('renderPage'));
  await assert.rejects(exportView(directory, output, { renderPage: cockpitPage }), missingService('runCommand'));
  assert.equal(existsSync(output), false, 'a refused export writes no snapshot');
});
