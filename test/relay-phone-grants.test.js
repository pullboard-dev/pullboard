/** Native phone grants are bounded to one authenticated action and consumed atomically [H13,H16,B26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRelayAuth } from '../relay/auth.js';
import { createGitHubClient } from '../relay/github.js';
import { githubFixture } from './relay-fixture.js';

/** Exercise real OAuth and SQLite without persisting a plaintext phone session. */
async function fixture(t) {
  const provider = await githubFixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-phone-grants-'));
  let now = Date.now();
  const database = join(directory, 'auth.sqlite');
  const options = { database, github: createGitHubClient(provider.config), now: () => now };
  const auth = createRelayAuth(options);
  const second = createRelayAuth(options);
  t.after(() => { second.close(); auth.close(); rmSync(directory, { recursive: true, force: true }); });
  const flow = auth.beginWeb();
  const authorization = await fetch(flow.authorizationURL, { redirect: 'manual' });
  const callback = new URL(authorization.headers.get('location'));
  const phone = await auth.finishWeb(callback.searchParams.get('state'), callback.searchParams.get('code'), flow.binding);
  const board = 'a'.repeat(32);
  await auth.linkBoard(phone.token, board, 'fixture/repository');
  const machine = await auth.issueMachine(phone.token, { board, machine: 'native-grant-machine' });
  const other = await auth.issueMachine(phone.token, { board, machine: 'other-native-machine' });
  const agent = await auth.issueToken(machine.token, { board, agent: 'grant-worker' });
  /** Produce a unique action with the same immutable display and execution fields. */
  function context(id, overrides = {}) {
    return { id, account: phone.user.id, publisher: board, board, device: 'device-' + 'd'.repeat(32),
      action: 'revoke-token', target: agent.id, machine: machine.machine, command: 'pullboard relay revoke ' + agent.id,
      expires: now + 600_000, ...overrides };
  }
  return { auth, second, phone, machine, other, agent, context, provider, directory, advance(ms) { now += ms; }, now: () => now };
}

test('phone grants expire, bind every action field and permit one execution across processes [H13,H16,B26]', async t => {
  const box = await fixture(t);
  const context = box.context('grant-boundary-one');
  await assert.rejects(box.auth.issueActionGrant(box.machine.token, context), { code: 'HUMAN_REQUIRED' });
  await assert.rejects(box.auth.issueActionGrant(box.agent.token, context), { code: 'HUMAN_REQUIRED' });
  const approved = await box.auth.issueActionGrant(box.phone.token, context);
  assert.equal(/^pg_[A-Za-z0-9_-]{43}$/u.test(approved.grant), true);
  assert.equal(approved.expires, box.now() + 120_000, 'a ten-minute proposal yields at most two minutes of action authority');
  const bytes = Buffer.concat(readdirSync(box.directory).map(name => readFileSync(join(box.directory, name))));
  assert.equal(bytes.includes(approved.grant), false, 'SQLite and WAL retain only a hash of the single-use grant');
  await assert.rejects(box.auth.authenticate(approved.grant), { code: 'AUTH_REQUIRED' });
  await assert.rejects(box.auth.consumeActionGrant(box.phone.token, approved.grant, context), { code: 'HUMAN_REQUIRED' });
  await assert.rejects(box.auth.consumeActionGrant(box.agent.token, approved.grant, context), { code: 'HUMAN_REQUIRED' });
  await assert.rejects(box.auth.consumeActionGrant(box.other.token, approved.grant, context), { code: 'HUMAN_REQUIRED' });
  for (const changed of [
    { id: 'other-request' }, { target: 'another-token' }, { device: 'device-' + 'e'.repeat(32) },
    { command: 'pullboard relay revoke another-token' }, { expires: context.expires - 1 },
    { action: 'revoke-device', target: 'device-' + 'e'.repeat(32) },
  ]) {
    await assert.rejects(box.auth.consumeActionGrant(box.machine.token, approved.grant, { ...context, ...changed }), { code: 'PHONE_APPROVAL_USED' });
  }
  await assert.rejects(box.auth.issueActionGrant(box.phone.token, context), { code: 'PHONE_APPROVAL_USED' });
  const attempts = await Promise.allSettled([
    box.auth.consumeActionGrant(box.machine.token, approved.grant, context),
    box.second.consumeActionGrant(box.machine.token, approved.grant, context),
  ]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1, 'two SQLite connections cannot both consume a grant');
  assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'PHONE_APPROVAL_USED');
  const principal = attempts.find(result => result.status === 'fulfilled').value;
  assert.deepEqual(await box.auth.revokeApprovedToken(principal, box.agent.id, context.board), { id: box.agent.id, revoked: true });
  await assert.rejects(box.auth.authenticate(box.agent.token), { code: 'AUTH_REQUIRED' });

  const expires = box.context('grant-expiry');
  const short = await box.auth.issueActionGrant(box.phone.token, expires);
  box.advance(120_000);
  await assert.rejects(box.auth.consumeActionGrant(box.machine.token, short.grant, expires), { code: 'PHONE_APPROVAL_USED' });
  const unavailable = box.context('permission-lost');
  const beforeLoss = await box.auth.issueActionGrant(box.phone.token, unavailable);
  box.provider.state.access = false;
  await assert.rejects(box.auth.consumeActionGrant(box.machine.token, beforeLoss.grant, unavailable), { code: 'NO_REPO_ACCESS' });
});
