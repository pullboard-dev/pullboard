/** @pullboard-test-input source-cell apps/relay */
/** @pullboard-world-pin: the cases drive the real relay auth, SQLite store and HTTP route with only the clock faked. */
/** A live machine credential renews by 30 days, so a used machine stays signed in [C7]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAuthHandler } from '../../index.js';
import { createGitHubClient } from '../../index.js';
import { createRelayAuth } from '../../index.js';
import { githubFixture } from '../../../cli/tests/fixtures/relay.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';

const DAY = 24 * 3600_000;
const MONTH = 30 * DAY;

/** Build a relay with a person, a linked board and a controllable clock. */
async function relayFixture(t) {
  const provider = await githubFixture(t);
  const directory = privateFixtureFiles('pullboard-credential-renew-').root;
  let current = Date.now();
  const auth = createRelayAuth({ database: join(directory, 'auth.sqlite'), github: createGitHubClient(provider.config), now: () => current });
  const server = createServer(createAuthHandler({ auth, publicOrigin: 'http://127.0.0.1' }));
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(done => server.close(done));
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const flow = await auth.beginDevice();
  await fetch(flow.verificationURL);
  current += flow.interval * 1000;
  const person = await auth.pollDevice(flow.ticket);
  const board = 'b'.repeat(32);
  await auth.linkBoard(person.token, board, 'fixture/repository', Infinity, null);
  return {
    auth, person, board,
    now: () => current,
    advance(ms) { current += ms; },
    origin: 'http://127.0.0.1:' + server.address().port,
  };
}

test('clause 1: a renew on day 29 moves a live machine credential to now plus 30 days [C7]', async t => {
  const box = await relayFixture(t);
  const machine = await box.auth.issueMachine(box.person.token, { board: box.board, machine: 'laptop' });
  box.advance(29 * DAY);
  const renewed = await box.auth.renewCredential(machine.token, { board: box.board });
  assert.equal(renewed.expires, box.now() + MONTH);
  assert.equal(renewed.machine, 'laptop');
  assert.equal(renewed.token, undefined, 'a renewal never returns a bearer value');
  box.advance(MONTH - DAY);
  await box.auth.renewCredential(machine.token, { board: box.board });
});

test('clause 1: an unused machine credential still expires at 30 days [C7]', async t => {
  const box = await relayFixture(t);
  const machine = await box.auth.issueMachine(box.person.token, { board: box.board, machine: 'idle' });
  box.advance(MONTH);
  await assert.rejects(box.auth.renewCredential(machine.token, { board: box.board }), { code: 'AUTH_REQUIRED' });
});

test('clause 1: a rotated root coordinator keeps a 30-day lease while agent tokens keep their short life [C7]', async t => {
  const box = await relayFixture(t);
  const first = await box.auth.issueCoordinator(box.person.token, { board: box.board });
  const rotated = await box.auth.issueToken(first.token, { board: box.board, agent: 'coordinator' });
  assert.equal(rotated.expires, box.now() + MONTH);
  const agent = await box.auth.issueToken(box.person.token, { board: box.board, agent: 'worker-1' });
  assert.equal(agent.expires, box.now() + DAY);
});

test('clause 1: the renew route extends a machine credential over HTTP [C7]', async t => {
  const box = await relayFixture(t);
  const machine = await box.auth.issueMachine(box.person.token, { board: box.board, machine: 'http' });
  box.advance(10 * DAY);
  const answer = await fetch(box.origin + '/auth/credentials/renew', { method: 'POST',
    headers: { Authorization: 'Bearer ' + machine.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ board: box.board }) });
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).expires, box.now() + MONTH);
});

test('clause 2: an expired or revoked credential is refused before any renewal [C7]', async t => {
  const box = await relayFixture(t);
  const expired = await box.auth.issueMachine(box.person.token, { board: box.board, machine: 'old', expiresIn: DAY });
  const revoked = await box.auth.issueMachine(box.person.token, { board: box.board, machine: 'gone' });
  await box.auth.revoke(box.person.token, revoked.id);
  box.advance(2 * DAY);
  await assert.rejects(box.auth.renewCredential(expired.token, { board: box.board }), { code: 'AUTH_REQUIRED' });
  await assert.rejects(box.auth.renewCredential(revoked.token, { board: box.board }), { code: 'AUTH_REQUIRED' });
});
