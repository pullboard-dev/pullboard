import { viewApiPorts } from '../../../../view/index.js';
import { apiBoardOpeners } from '../../../tests/fixtures/board.js';
import { nativeBoardPorts as relayPresentationNativePorts } from '../../../../lib/index.js';
/** Local API projection for private relay-canary alerts; never part of the sealed relay view. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalApiHandler } from '../../../../../packages/api/index.js';
import { refusalDocument } from '../../../index.js';
import { relaySnapshot } from '../../../../../packages/pages/index.js';
import { observeRelayHealth } from '../../../../../packages/link/index.js';
import { main } from '../../../tests/fixtures/native.js';
import { apiFetch } from '../../../tests/fixtures/api.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

const helpers = createE2eHelpers();
test.after(() => helpers.cleanup());

/** Keep process-global repository discovery inside one private fixture and restore it after the test. */
async function withFixtureEnvironment(env, action) {
  const names = ['PATH', 'HOME', 'PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    if (Object.hasOwn(env, name)) process.env[name] = env[name];
    else delete process.env[name];
  }
  try { return await action(); }
  finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

/** Count native board events without opening a write-capable board connection. */
function eventCount(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) AS count FROM event').get().count; }
  finally { db.close(); }
}

test('local API refreshes private relay health without adding it to a sealed presentation [A2,H5,H17]', async (t) => {
  const box = helpers.project('true');
  await withFixtureEnvironment(box.env, async () => {
    const secret = randomBytes(24).toString('base64url');
    let port = 0;
    const handler = createLocalApiHandler({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument,
      secret,
      getPort: () => port,
      runCommand: main,
      projects: () => [{ root: box.repo, name: 'Canary API fixture', project: '', added: '2026-10-25T00:00:00.000Z' }],
    });
    const server = createServer(handler);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
    });
    t.after(async () => {
      handler.close();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
    });

    const api = { origin: `http://127.0.0.1:${port}`, secret };
    const listingResponse = await apiFetch(api, '/api/v1/boards');
    assert.equal(listingResponse.status, 200);
    const listing = await listingResponse.json();
    const board = listing.boards.find((entry) => entry.root === box.repo);
    assert.ok(board?.id, 'the real local API lists the initialized Git board');
    const statePath = `/api/v1/boards/${encodeURIComponent(board.id)}/state`;
    const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
    const beforeEvents = eventCount(boardFile);

    const initialResponse = await apiFetch(api, statePath);
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json();
    assert.deepEqual(initial.state.relayHealthAlerts, [], 'the private local API starts without a canary alert');

    const firstAt = Date.now();
    const failedPull = { ok: false, step: 'pull', code: 'RELAY_READ', roundTripMs: 73, relayVersion: 1 };
    observeRelayHealth(box.repo, failedPull, { now: firstAt });
    const secondAt = Date.now();
    assert.ok(secondAt >= firstAt, 'sample timestamps come from the actual clock, never a future fixture date');
    const alert = observeRelayHealth(box.repo, failedPull, { now: secondAt });
    assert.equal(alert.transition, 'alert', 'the second real persisted failure creates the local alert');

    const degradedResponse = await apiFetch(api, statePath);
    assert.equal(degradedResponse.status, 200);
    const degraded = await degradedResponse.json();
    assert.notEqual(degradedResponse.headers.get('etag'), initialResponse.headers.get('etag'),
      'the private health database revision invalidates the already-primed API state cache');
    assert.equal(degraded.state.relayHealthAlerts.length, 1);
    assert.equal(degraded.state.relayHealthAlerts[0].step, 'pull');
    assert.match(degraded.state.relayHealthAlerts[0].text, /relay degraded since .*your moves are queued locally/u);
    assert.ok(degraded.state.needs.some((entry) => entry.kind === 'relay-health' && entry.id === 'relay-canary'),
      'the local Needs-you projection includes the current canary alert');

    const sealedDuringAlert = relaySnapshot(box.repo, {}, RELAY_PRESENTATION_PORTS);
    assert.equal(Object.hasOwn(sealedDuringAlert.presentation.state, 'relayHealthAlerts'), false,
      'host-local health is not serialized into the device-sealed presentation');
    assert.equal(sealedDuringAlert.presentation.state.needs.some((entry) => entry.kind === 'relay-health'), false,
      'a relay snapshot does not disclose this publishing host’s private health alert');

    const recoveryAt = Date.now();
    const recovered = observeRelayHealth(box.repo, {
      ok: true, step: 'complete', code: 'OK', roundTripMs: 21, relayVersion: 1,
    }, { now: recoveryAt });
    assert.equal(recovered.transition, 'recovery');
    const recoveredResponse = await apiFetch(api, statePath);
    assert.equal(recoveredResponse.status, 200);
    const recoveredState = await recoveredResponse.json();
    assert.notEqual(recoveredResponse.headers.get('etag'), degradedResponse.headers.get('etag'),
      'recovery also invalidates the cached local API state');
    assert.deepEqual(recoveredState.state.relayHealthAlerts, []);
    assert.equal(recoveredState.state.needs.some((entry) => entry.kind === 'relay-health'), false,
      'the local Needs-you alert disappears after a successful complete round trip');

    assert.equal(eventCount(boardFile), beforeEvents,
      'health changes and API refreshes do not write a native board event');
    const sealedAfterRecovery = relaySnapshot(box.repo, {}, RELAY_PRESENTATION_PORTS);
    assert.equal(Object.hasOwn(sealedAfterRecovery.presentation.state, 'relayHealthAlerts'), false);
    assert.equal(JSON.stringify(sealedAfterRecovery.presentation).includes('relay-canary'), false,
      'private canary status remains outside the sealed snapshot after recovery too');
  });
});
