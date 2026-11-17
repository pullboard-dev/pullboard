/** A linked machine stays signed in: each sync extends its credential, and health warns before any expiry [H5,H16]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ACCESS_WINDOW_MS,
  createAuthHandler,
  createGitHubClient,
  createRelayAuth,
} from '../../../relay/index.js';
import { refusalDocument } from '../../index.js';
import { dispatchHealth } from '../../../../packages/sentinels/index.js';
import { boardHealth } from '../../../../packages/health/index.js';
import { createApiHandler } from '../../../../packages/api/index.js';
import {
  actorTransport,
  renewAfterSync,
} from '../../../../packages/link/index.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { githubFixture } from '../../tests/fixtures/relay.js';
import { relayWorkBudgetMs } from '../../tests/fixtures/scenarios/team.js';

/** Read only private link metadata; callers never include credential values in diagnostics. */
function linkState(root) {
  return JSON.parse(readFileSync(join(root, '.git/pullboard/relay.json'), 'utf8'));
}

/** Exercise rolling leases through real CLI syncs without changing a credential database directly. */
test('clause 1: a used machine stays signed in, and clause 2: health warns before expiry [H5,H16]', { timeout: relayWorkBudgetMs(12) }, async (t) => { // budget: hang ceiling for real CLI and relay round trips; not a speed target.
  const box = await relayClientFixture(t);
  await box.link();
  const { auth, root } = box;
  const DAY = 86_400_000;
  let offset = 0;
  /** The relay auth clock: real time plus every advance this case applies. */
  const authNow = () => Date.now() + offset;
  /** Move only the relay auth clock, as the fixture does for every other expiry case. */
  const advance = ms => { offset += ms; box.advanceAuthorization(ms); };
  const initial = linkState(root);
  const first = await auth.authenticate(initial.token, { board: initial.board });
  const flow = await auth.beginDevice();
  await fetch(flow.verificationURL);
  advance(flow.interval * 1000);
  const person = await auth.pollDevice(flow.ticket);
  const unused = await auth.issueMachine(person.token, { board: initial.board, machine: 'unused-computer' });
  advance(first.expires - DAY - authNow());
  const before = box.calls.length;
  const started = authNow();
  assert.equal((await box.cli('relay', 'status')).code, 0, 'day-29 sync succeeds without signing in again');
  const finished = authNow();
  assert.ok(box.calls.slice(before).some(call => call.method === 'GET' && call.path.startsWith('/api/')), 'the real relay sync reached its board transport');
  const used = linkState(root);
  const live = await auth.authenticate(used.token, { board: used.board });
  assert.ok(live.expires >= started + 30 * DAY && live.expires <= finished + 30 * DAY, 'a successful sync rolls the existing machine credential forward thirty days');
  assert.equal(used.token, initial.token, 'renewal does not require a replacement machine secret');
  const coordinator = await auth.authenticate(used.agentTokens.coordinator.token, { board: used.board });
  assert.equal(coordinator.root, true, 'sync preserves the person-issued coordinator authority');
  assert.ok(coordinator.expires >= started + 30 * DAY && coordinator.expires <= finished + 30 * DAY, 'the same sync renews the current coordinator token');
  assert.equal(box.calls.slice(before).some(call => call.path === '/auth/device/start'), false, 'no background sign-in or person-session mint occurs');
  const link = box.linkFile;
  const bytes = readFileSync(link);
  const health = boardHealth(join(root, '.git/pullboard/board.sqlite'), { root, now: new Date(started + 28 * DAY), dispatchHealth });
  const warnings = health.stuck.filter(finding => finding.cause === 'RELAY_CREDENTIAL_EXPIRING');
  assert.deepEqual(warnings.map(finding => finding.detail.kind).sort(), ['coordinator', 'machine'], 'health names both credentials two days before expiry');
  assert.ok(warnings.every(finding => finding.next.includes('pullboard relay on')), 'each warning gives the explicit sign-in repair');
  assert.deepEqual(readFileSync(link), bytes, 'health only observes the saved credential metadata');
  assert.equal(JSON.stringify(health).includes(used.token), false, 'health never exposes the machine bearer');
  assert.equal(JSON.stringify(health).includes(used.agentTokens.coordinator.token), false, 'health never exposes the coordinator bearer');
  advance(unused.expires - authNow());
  await assert.rejects(auth.authenticate(unused.token, { board: used.board }), { code: 'AUTH_REQUIRED' }, 'an unused machine still expires at thirty days');
  assert.equal((await auth.authenticate(used.token, { board: used.board })).kind, 'machine', 'the monthly-used machine remains linked');
  advance(live.expires - authNow());
  await assert.rejects(auth.authenticate(used.token, { board: used.board }), { code: 'AUTH_REQUIRED' }, 'a credential cannot renew itself after its actual expiry');
});

/** Renewal retains the live principal and repeats current access checks rather than minting new authority. */
test('clause 1: rolling renewal preserves credential scope, revocation and awaited expiry [H2,H5,H16]', async (t) => {
  const provider = await githubFixture(t);
  const root = privateFixtureFiles('pullboard-renewal-boundary-').root;
  const database = join(root, 'auth.sqlite');
  let now = Date.now();
  const auth = createRelayAuth({ database, github: createGitHubClient(provider.config), now: () => now });
  t.after(() => { auth.close(); rmSync(root, { recursive: true, force: true }); });
  const flow = await auth.beginDevice();
  await fetch(flow.verificationURL);
  now += flow.interval * 1000;
  const person = await auth.pollDevice(flow.ticket);
  const board = 'a'.repeat(32);
  const other = 'b'.repeat(32);
  await auth.linkBoard(person.token, board, 'fixture/repository');
  await auth.linkBoard(person.token, other, 'fixture/repository-2');
  const machine = await auth.issueMachine(person.token, { board, machine: 'rolling-boundary' });
  const coordinator = await auth.issueCoordinator(person.token, { board });
  const agent = await auth.issueToken(machine.token, { board, agent: 'ordinary-agent' });
  const original = await auth.authenticate(coordinator.token, { board });
  const renewed = await auth.renewCredential(coordinator.token, { board });
  const current = await auth.authenticate(coordinator.token, { board });
  assert.equal(renewed.id, coordinator.id, 'renewal does not replace the authenticated principal');
  assert.equal(current.root, true);
  assert.equal(current.lineage, original.lineage, 'renewal cannot replace coordinator lineage');
  assert.equal(current.expires, now + 30 * 86_400_000);
  assert.equal(Object.hasOwn(renewed, 'token'), false, 'the response contains only public expiry metadata');
  await assert.rejects(auth.renewCredential(machine.token, { board: other }), { code: 'TOKEN_BOARD' });
  await assert.rejects(auth.renewCredential(agent.token, { board }), { code: 'HUMAN_REQUIRED' });
  await assert.rejects(auth.renewCredential(person.token, { board }), { code: 'HUMAN_REQUIRED' });
  const revoked = await auth.issueMachine(person.token, { board, machine: 'revoked-boundary' });
  await auth.revoke(person.token, revoked.id);
  await assert.rejects(auth.renewCredential(revoked.token, { board }), { code: 'AUTH_REQUIRED' });
  const expired = await auth.issueMachine(person.token, { board, machine: 'expired-boundary', expiresIn: 1 });
  now += 2;
  await assert.rejects(auth.renewCredential(expired.token, { board }), { code: 'AUTH_REQUIRED' });
  provider.state.access = false;
  now += ACCESS_WINDOW_MS + 1; // a cached permission is refreshed only after its window
  await assert.rejects(auth.renewCredential(machine.token, { board }), { code: 'NO_REPO_ACCESS' }, 'a formerly valid account must still have current write access');
  provider.state.access = true;
  now += ACCESS_WINDOW_MS + 1;
  provider.state.beforePermission = () => { now = machine.expires; };
  await assert.rejects(auth.renewCredential(machine.token, { board }), { code: 'AUTH_REQUIRED' }, 'expiry while the permission lookup awaits is not revived');
  assert.equal(readFileSync(database).includes(machine.token), false, 'renewal never writes a machine bearer to SQLite');
});


/** The old relay delegates an unknown auth route to the real common API boundary. */
test('clause 1: successful sync tolerates the legacy relay renewal endpoint refusal [H5,H16]', async (t) => {
  const scratch = privateFixtureFiles('pullboard-legacy-renewal-').root;
  const provider = await githubFixture(t);
  let now = Date.now();
  const auth = createRelayAuth({ database: join(scratch, 'auth.sqlite'), github: createGitHubClient(provider.config), now: () => now });
  const flow = await auth.beginDevice();
  await fetch(flow.verificationURL);
  now += flow.interval * 1000;
  const person = await auth.pollDevice(flow.ticket);
  const board = 'a'.repeat(32);
  await auth.linkBoard(person.token, board, 'fixture/repository');
  const machine = await auth.issueMachine(person.token, { board, machine: 'legacy-machine' });
  let verified = 0;
  const api = createApiHandler({ refusalDocument, authenticate: async req => {
    const principal = await auth.authenticate(req.headers.authorization?.replace(/^Bearer /, ''), { board, write: true });
    assert.equal(principal.kind, 'machine');
    verified += 1;
    return principal;
  } });
  const paths = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url);
    await api(req, res);
  });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(done => server.close(done));
    auth.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  const response = await fetch(url + '/auth/credentials/renew', { method: 'POST', headers: { authorization: 'Bearer ' + machine.token } });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'NO_ENDPOINT', 'the production common API supplies the old-server refusal');
  const file = join(scratch, 'link.json');
  const state = { url, board, machine: 'legacy-machine', token: machine.token, tokenId: machine.id, tokenExpires: machine.expires };
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  const before = readFileSync(file);
  await assert.doesNotReject(renewAfterSync(file, state, { err() {} }), 'post-sync maintenance must not turn an old relay successful sync into a failure');
  assert.ok(paths.includes('/auth/credentials/renew'));
  assert.equal(verified, 2, 'both old-server calls verified the real private machine credential');
  assert.deepEqual(readFileSync(file), before, 'unsupported renewal cannot invent expiry or replace credentials');
});

/** Issue in the past through auth clock injection, then let the real client half-life rule rotate now. */
test('clause 1: coordinator half-life rotation preserves a rolling monthly credential [H5,H16]', async (t) => {
  const provider = await githubFixture(t);
  const scratch = privateFixtureFiles('pullboard-coordinator-rotation-').root;
  const DAY = 86_400_000;
  let now = Date.now() - 20 * DAY;
  const auth = createRelayAuth({ database: join(scratch, 'auth.sqlite'), github: createGitHubClient(provider.config), now: () => now });
  const flow = await auth.beginDevice();
  await fetch(flow.verificationURL);
  now += flow.interval * 1000;
  const person = await auth.pollDevice(flow.ticket);
  const board = 'b'.repeat(32);
  await auth.linkBoard(person.token, board, 'fixture/repository');
  const machine = await auth.issueMachine(person.token, { board, machine: 'monthly-rotation' });
  const issued = await auth.issueCoordinator(person.token, { board });
  const renewed = await auth.renewCredential(issued.token, { board });
  const original = await auth.authenticate(issued.token, { board });
  const calls = [];
  let handler;
  const server = createServer(async (req, res) => { calls.push(req.url); await handler(req, res); });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(done => server.close(done));
    auth.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  handler = createAuthHandler({ auth, publicOrigin: url });
  const state = { url, board, machine: 'monthly-rotation', token: machine.token,
    agentTokens: { coordinator: { ...issued, renewedAt: renewed.renewedAt, expires: renewed.expires } } };
  const file = join(scratch, 'link.json');
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  now = Date.now();
  assert.ok(renewed.renewedAt < now - 15 * DAY && renewed.expires > now, 'the cached credential is live and genuinely past its half-life at the client clock');
  const transport = await actorTransport(scratch, file, state, 'coordinator', { ignoreRelayEnvironmentToken: true, err() {} });
  assert.ok(calls.includes('/auth/tokens'), 'the actual client selected ordinary self-rotation');
  assert.notEqual(transport.token, issued.token, 'the actual relay replaced the rotating token');
  const rotated = await auth.authenticate(transport.token, { board });
  assert.equal(rotated.root, true);
  assert.equal(rotated.lineage, original.lineage, 'rotation retains the same person-issued lineage');
  assert.ok(rotated.expires >= now + 30 * DAY, 'rotation cannot shorten rolling monthly access to the default one-day agent TTL');
  now += 29 * DAY;
  assert.equal((await auth.authenticate(transport.token, { board })).agent, 'coordinator', 'a monthly return still has its existing coordinator authority');
});
