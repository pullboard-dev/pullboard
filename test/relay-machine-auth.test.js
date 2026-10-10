/** Board-bound machine credentials remain narrower than person sessions [H16,B26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRelayAuth } from '../relay/auth.js';
import { createGitHubClient } from '../relay/github.js';
import { githubFixture } from './relay-fixture.js';

/** Create an actual signed-in account against the loopback GitHub protocol fixture. */
async function signedPerson(box, auth) {
  const flow = await auth.beginDevice();
  await fetch(flow.verificationURL);
  box.advance(flow.interval * 1000);
  return auth.pollDevice(flow.ticket);
}

test('machine credentials mint and list same-board agents but cannot link, revoke, or mint machines [H16,B26]', async (t) => {
  const provider = await githubFixture(t);
  const root = mkdtempSync(join(tmpdir(), 'pullboard-machine-auth-'));
  let now = Date.now();
  const auth = createRelayAuth({ database: join(root, 'auth.sqlite'), github: createGitHubClient(provider.config), now: () => now });
  t.after(() => { auth.close(); rmSync(root, { recursive: true, force: true }); });
  const box = { ...provider, advance(ms) { now += ms; } };
  const person = await signedPerson(box, auth);
  const alpha = 'a'.repeat(32);
  const beta = 'b'.repeat(32);
  await auth.linkBoard(person.token, alpha, 'fixture/repository');
  await auth.linkBoard(person.token, beta, 'fixture/repository');

  const machine = await auth.issueMachine(person.token, { board: alpha, machine: 'mac-alpha' });
  assert.match(machine.token, /^pm_[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(machine.token, person.token);
  assert.equal(machine.board, alpha);
  assert.equal(machine.machine, 'mac-alpha');
  assert.equal(readFileSync(join(root, 'auth.sqlite')).includes(machine.token), false, 'SQLite stores only the machine credential hash');
  const identity = await auth.authenticate(machine.token, { board: alpha });
  assert.equal(identity.kind, 'machine');
  assert.equal(identity.board, alpha);
  assert.equal(identity.machine, 'mac-alpha');
  assert.deepEqual((await auth.boardsFor(machine.token)).map(row => row.id), [alpha], 'machine inventory stays on its own board');

  const agent = await auth.issueToken(machine.token, { board: alpha, agent: 'worker-alpha' });
  assert.match(agent.token, /^pa_[A-Za-z0-9_-]{43}$/u);
  assert.equal(agent.board, alpha);
  assert.equal(agent.agent, 'worker-alpha');
  assert.deepEqual((await auth.boardsFor(agent.token)).map(row => row.id), [alpha], 'agent inventory stays on its own board');

  await assert.rejects(auth.authenticate(machine.token, { board: beta }), { code: 'TOKEN_BOARD' });
  await assert.rejects(auth.issueMachine(machine.token, { board: beta, machine: 'mac-beta' }), { code: 'TOKEN_BOARD' });
  await assert.rejects(auth.issueMachine(agent.token, { board: alpha, machine: 'agent-machine' }), { code: 'HUMAN_REQUIRED' });
  await assert.rejects(auth.issueMachine(machine.token, { board: alpha, machine: 'nested-machine' }), { code: 'HUMAN_REQUIRED' });
  await assert.rejects(auth.linkBoard(machine.token, 'c'.repeat(32), 'fixture/repository'), { code: 'HUMAN_REQUIRED' });
  const tokens = await auth.listTokens(machine.token, alpha);
  assert.deepEqual(tokens.map(value => value.id), [agent.id]);
  assert.equal(tokens.some(value => Object.hasOwn(value, 'token') || Object.hasOwn(value, 'hash')), false);
  await assert.rejects(auth.listTokens(machine.token, beta), { code: 'TOKEN_BOARD' });
  await assert.rejects(auth.issueToken(machine.token, { board: beta, agent: 'cross-board' }), { code: 'TOKEN_BOARD' });
  assert.equal(auth.minimumEngineVersion(alpha), 6);
  await assert.rejects(auth.listTokens(agent.token, alpha), { code: 'HUMAN_REQUIRED' });
  await assert.rejects(auth.revoke(machine.token, agent.id), { code: 'TOKEN_NOT_OWNED' });

  const personIssued = await auth.issueToken(person.token, { board: alpha, agent: 'worker-person' });
  assert.equal((await auth.authenticate(personIssued.token, { board: alpha })).kind, 'board');
  assert.deepEqual((await auth.boardsFor(person.token)).map(row => row.id), [alpha, beta], 'only the person session can inventory multiple linked boards');
});
