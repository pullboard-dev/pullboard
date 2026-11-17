/** A relay data folder written by v0.9.3 opens on the current service with its journals and credentials intact [C7,H16]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../packages/gate/tests/fixtures/child.js';
import { githubFixture } from '../../cli/tests/fixtures/relay.js';
import { createGitHubClient } from '../index.js';
import { createRelayAuth } from '../index.js';
import { serveRelay } from '../index.js';

/** Recorded from the v0.9.3 tag (c3c21438eb) by running its relay code on synthetic fixture credentials, nothing real. */
const RECORDED = join(import.meta.dirname, 'fixtures', 'v093-data');
const ENGINE = '136'; // the engine v0.9.3 declared on every request

/** Open a fresh copy of the recorded folder on the current relay service, with the clock the credentials were issued under. */
async function openRecorded(t) {
  const recorded = JSON.parse(readFileSync(join(RECORDED, 'credentials.json'), 'utf8'));
  const directory = privateFixtureFiles('pullboard-relay-v093-').root;
  cpSync(join(RECORDED, 'data'), join(directory, 'data'), { recursive: true });
  // Git keeps no modes: give the copy the private modes the deployed service prepares at startup (server.mjs prepareStorage).
  for (const folder of [join(directory, 'data'), join(directory, 'data', 'boards')]) {
    chmodSync(folder, 0o700);
    for (const name of readdirSync(folder, { withFileTypes: true })) if (name.isFile()) chmodSync(join(folder, name.name), 0o600);
  }
  const provider = await githubFixture(t);
  const auth = createRelayAuth({ database: join(directory, 'data', 'auth.sqlite'), github: createGitHubClient(provider.config), now: () => recorded.recordedAt + 3600_000 });
  const relay = await serveRelay({ directory: join(directory, 'data', 'boards'), auth, maintenanceMs: 0, pollMs: 10 });
  t.after(async () => { await relay.close(); auth.close(); rmSync(directory, { recursive: true, force: true }); });
  /** Call the opened board as one recorded credential would. */
  const call = async (token, path) => {
    const response = await fetch(`http://127.0.0.1:${relay.port}/api/v1/boards/${recorded.board}${path}`, { headers: { authorization: `Bearer ${token}`, 'x-pullboard-engine': ENGINE } });
    return { status: response.status, document: await response.json().catch(() => null) };
  };
  return { recorded, call, auth };
}

test('relay.v093-data-folder.the-current-service-opens-a-v0: clause 1: the current service opens a v0.9.3 relay data folder and reads its recorded journal [C7,H16]', async (t) => {
  const { recorded, call } = await openRecorded(t);
  const state = await call(recorded.machine, '/state');
  assert.equal(state.status, 200, JSON.stringify(state.document));
  assert.equal(state.document.state.sealed, recorded.snapshot);
  const events = await call(recorded.machine, '/events?after=0');
  assert.equal(events.status, 200, JSON.stringify(events.document));
  assert.deepEqual(events.document.events.map((event) => event.sealed), recorded.sealed, 'both recorded moves read back in order');
});

test('relay.v093-data-folder.the-recorded-pm-and-pa-credentials: clause 2: the recorded pm_ and pa_ credentials still authenticate on the current service [C7,H16]', async (t) => {
  const { recorded, call, auth } = await openRecorded(t);
  assert.match(recorded.machine, /^pm_/u);
  assert.match(recorded.agent, /^pa_/u);
  for (const token of [recorded.machine, recorded.agent]) {
    const read = await call(token, '/events?after=0');
    assert.equal(read.status, 200, JSON.stringify(read.document));
  }
  assert.equal((await auth.authenticate(recorded.machine, { board: recorded.board })).kind, 'machine');
  assert.equal((await auth.authenticate(recorded.agent, { board: recorded.board })).kind, 'board');
  assert.equal((await call('pm_' + 'x'.repeat(43), '/state')).status, 401, 'a credential that was never recorded does not authenticate');
});
