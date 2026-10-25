/** Board-bound machine credentials remain narrower than person sessions [H16,B26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createRelayAuth } from '../relay/auth.js';
import { createGitHubClient } from '../relay/github.js';
import { githubFixture } from './relay-fixture.js';
import { VERIFIER_STANDING_ENGINE } from '../src/machine.js';

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
  await auth.linkBoard(person.token, beta, 'fixture/repository-2'); // one team board per repository [E12]

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
  assert.equal(auth.minimumEngineVersion(alpha), VERIFIER_STANDING_ENGINE, `machine and agent credentials require engine ${VERIFIER_STANDING_ENGINE} (#579)`);
  await assert.rejects(auth.listTokens(agent.token, alpha), { code: 'HUMAN_REQUIRED' });
  await assert.rejects(auth.revoke(machine.token, agent.id), { code: 'TOKEN_NOT_OWNED' });

  const personIssued = await auth.issueToken(person.token, { board: alpha, agent: 'worker-person' });
  assert.equal((await auth.authenticate(personIssued.token, { board: alpha })).kind, 'board');
  assert.deepEqual((await auth.boardsFor(person.token)).map(row => row.id), [alpha, beta], 'only the person session can inventory multiple linked boards');
});


test('deleted-copy receipts grant no access and keep revocation and expiry distinct [H16,H17,E9]', async (t) => {
  const provider = await githubFixture(t);
  const root = mkdtempSync(join(tmpdir(), 'pullboard-deleted-credential-'));
  const database = join(root, 'auth.sqlite');
  let now = Date.now();
  const options = { database, github: createGitHubClient(provider.config), now: () => now };
  let auth = createRelayAuth(options);
  t.after(() => { auth.close(); rmSync(root, { recursive: true, force: true }); });
  const person = await signedPerson({ ...provider, advance(ms) { now += ms; } }, auth);
  const alpha = 'a'.repeat(32), beta = 'b'.repeat(32);
  await auth.linkBoard(person.token, alpha, 'fixture/repository');
  await auth.linkBoard(person.token, beta, 'fixture/repository-2'); // one team board per repository [E12]
  const live = await auth.issueMachine(person.token, { board: alpha, machine: 'joined-alpha' });
  const revoked = await auth.issueMachine(person.token, { board: alpha, machine: 'revoked-alpha' });
  const expired = await auth.issueMachine(person.token, { board: alpha, machine: 'expired-alpha', expiresIn: 1 });
  const other = await auth.issueMachine(person.token, { board: beta, machine: 'joined-beta' });
  await auth.revoke(person.token, revoked.id);
  now += 2;
  assert.deepEqual((await auth.listMachines(live.token, alpha)).map(row => row.machine), ['joined-alpha'],
    'the roster excludes revoked and expired computer credentials');
  await assert.rejects(auth.listMachines(live.token, beta), { code: 'TOKEN_BOARD' });
  auth.forgetBoard(alpha);
  auth.close(); auth = createRelayAuth(options);
  await assert.rejects(auth.authenticate(live.token, { board: alpha }), { code: 'RELAY_BOARD_DELETED' }, 'a live former credential receives only a durable deletion refusal');
  await assert.rejects(auth.authenticate(revoked.token, { board: alpha }), { code: 'AUTH_REQUIRED' }, 'an earlier revocation never becomes proof of deletion');
  await assert.rejects(auth.authenticate(expired.token, { board: alpha }), { code: 'AUTH_REQUIRED' }, 'an already expired credential never becomes proof of deletion');
  await assert.rejects(auth.authenticate('pm_' + 'A'.repeat(43), { board: alpha }), { code: 'AUTH_REQUIRED' }, 'an unknown credential learns nothing');
  assert.equal((await auth.authenticate(other.token, { board: beta })).machine, 'joined-beta');
  assert.equal((await auth.authenticate(person.token)).kind, 'session', 'board deletion never revokes the person session');
  let db = new DatabaseSync(database, { readOnly: true });
  try {
    const rows = db.prepare('SELECT hash,board,expires FROM relay_deleted_credentials').all();
    assert.equal(rows.length, 1, 'only the originally live credential has a receipt');
    assert.match(rows[0].hash, /^[0-9a-f]{64}$/u);
    assert.equal(rows[0].board, alpha);
    assert.equal(rows[0].expires, live.expires, 'the receipt never extends the original credential lifetime');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM relay_credentials WHERE board=?').get(alpha).count, 0, 'no deleted-board credential retains authority');
  } finally { db.close(); }
  assert.equal(readFileSync(database).includes(live.token), false, 'the deletion receipt persists no bearer value');
  now = live.expires;
  await assert.rejects(auth.authenticate(live.token, { board: alpha }), { code: 'AUTH_REQUIRED' });
  db = new DatabaseSync(database, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM relay_deleted_credentials').get().count, 0, 'expired deletion receipts are pruned'); }
  finally { db.close(); }
});
