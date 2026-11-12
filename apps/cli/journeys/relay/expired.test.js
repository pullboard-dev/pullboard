/** Expired relay credentials retain local reads and ordered, actor-scoped moves [H16,H5]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDeviceKeys,
  signDeviceEnrollment,
} from '../../../../packages/keys/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { relayOutboxSetting } from '../../index.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import {
  prepareKeylessInbox,
  readKeylessInbox,
} from '../../tests/fixtures/key.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/testkit.js';

const CLI = fileURLToPath(new URL('../../pullboard.js', import.meta.url));

/** Revoke one private fixture credential through the real relay authorization endpoint. */
async function revokeCredential(box, id) {
  const phone = await box.phoneSession();
  const response = await fetch(box.origin + '/auth/tokens/revoke', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + phone.token, 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  assert.equal(response.status, 200, 'the fixture revokes the selected opaque credential');
}

/** Record a relay revocation on this board's link, as pullboard relay revoke does after the phone approves it. */
function markRevoked(box, id) {
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  for (const credential of Object.values(state.agentTokens ?? {})) if (credential.id === id) credential.revoked = true;
  writeFileSync(box.linkFile, JSON.stringify(state) + '\n', { mode: 0o600 });
}

/** Read one real CLI result and check its single board-named local fallback diagnostic. */
async function assertLocalRead(box, board, ...args) {
  const result = await box.cliLocal(...args);
  assert.equal(result.code, 0, `${result.failure ?? `${args[0]} answers from the local board`}; ${JSON.stringify(result.document?.error ?? null)}`);
  assert.equal(result.document.diagnostics?.length, 1, `${args[0]} prints one auth-expiry line`);
  assert.match(result.document.diagnostics[0], new RegExp(board));
  assert.match(result.document.diagnostics[0], /sign-in expired or was revoked/u);
  assert.match(result.document.diagnostics[0], /pullboard relay on.*pullboard relay off/u);
  return result;
}

/** Commit one fixture-only opt-out choice so the ordinary command reads the same setting as production. */
function commitOutboxChoice(box, value) {
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.relay = { ...config.relay, outbox: value };
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${CLI}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', 'pullboard.json', 'SPEC.md'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore: configure relay outbox'], { cwd: box.root, env: box.env });
}

test('reads and status answer when the relay sign-in expired [H16,H5] [clause 1]', async t => {
  const box = await relayClientFixture(t);
  const obligation = await prepareKeylessInbox(box);
  commitOutboxChoice(box, false);
  await box.link();
  const seed = await box.cliLocal('add', box.lane, 'local read fixture');
  assert.equal(seed.code, 0, seed.failure ?? 'the private real relay accepts a fixture move');
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  await revokeCredential(box, state.tokenId);

  const board = state.board;
  await assertLocalRead(box, board, 'status');
  await assertLocalRead(box, board, 'spec', 'check');
  await assertLocalRead(box, board, 'show', String(seed.document.item.item_id));
  await assertLocalRead(box, board, 'list', '--all');
  await assertLocalRead(box, board, 'decisions');
  await readKeylessInbox(box, obligation, 'AUTH_REQUIRED');
  await assertLocalRead(box, board, 'inbox');
  const write = await box.cliLocal('shout', 'all', 'must not bypass expired authentication');
  assert.equal(write.document?.error?.code, 'AUTH_REQUIRED', 'explicit writes still require relay authentication');
  await assertLocalRead(box, board, 'log');
  const view = await assertLocalRead(box, board, 'view', '--export', join(box.root, 'local-view.html'));
  assert.equal(existsSync(view.document.path), true, 'the local view export is available after relay auth refusal');
});

test('a revoked agent token is never reminted from the machine credential; the person reissues the coordinator [H16,H5,H2] [clause 1]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const seed = await box.cliLocal('add', box.lane, 'seed agent credential');
  assert.equal(seed.code, 0, seed.failure ?? 'the coordinator token from relay on sends the first move');
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const agent = state.agentTokens.coordinator;
  assert.ok(agent?.id, 'the board link caches a scoped coordinator credential');
  await revokeCredential(box, agent.id);
  // The board knows this revocation, as pullboard relay revoke records it: a known-revoked seat refuses at once,
  // while an unknown one queues local-first and refuses at replay (coordinator ruling, #2729).
  markRevoked(box, agent.id);

  const before = (await box.cliLocal('export')).document.tables;
  const mintsBefore = box.calls.filter(call => call.method === 'POST' && call.path === '/auth/tokens').length;
  const acksBefore = box.moveAcks.length;
  const refused = await box.cliLocal('add', box.lane, 'move after agent-token revocation');
  assert.equal(refused.code, 1, 'the machine credential never replaces a revoked seat token (#579)');
  assert.equal(refused.document.error.code, 'TOKEN_REVOKED');
  assert.equal(box.calls.filter(call => call.method === 'POST' && call.path === '/auth/tokens').length, mintsBefore,
    'no replacement token is minted');
  assert.equal(box.moveAcks.length, acksBefore, 'the relay acknowledges no move');
  assert.deepEqual((await box.cliLocal('export')).document.tables, before, 'the refused move changes no local board state');

  // The person's own relay on reissues the coordinator token and records it.
  const relink = await box.cliLocal('relay', 'on', '--url', box.origin);
  assert.equal(relink.code, 0, relink.failure ?? 'relay on reissues the coordinator token from the person sign-in');
  const reissued = JSON.parse(readFileSync(box.linkFile, 'utf8')).agentTokens.coordinator;
  assert.notEqual(reissued.id, agent.id, 'a new coordinator token replaces the revoked one');
  const moved = await box.cliLocal('add', box.lane, 'move after person reissue');
  assert.equal(moved.code, 0, moved.failure ?? 'the reissued coordinator token sends moves again');
  const tokens = await box.cliLocal('relay', 'tokens');
  assert.equal(tokens.code, 0, tokens.failure ?? 'the token inventory lists the coordinator audit');
  assert.deepEqual(tokens.document.coordinatorEvents.map(row => row.reason), ['bootstrap', 'reissue']);
  assert.equal(tokens.document.coordinatorEvents[1].issued, reissued.id);
});

test('moves stay local while the machine credential expires, then replay after sign-in [H21,H16,H5] [clause 1]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const seed = await box.cliLocal('add', box.lane, 'seed revoked machine fixture');
  assert.equal(seed.code, 0, seed.failure ?? 'the initial move registers a scoped credential');
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const cliPath = fileURLToPath(new URL('../../pullboard.js', import.meta.url));
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${cliPath}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', '-A'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'test: prepare private ordered claim'], { cwd: box.root, env: box.env });
  const agentRoot = join(box.root, '..', 'claim-agent');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'core/auth-claim', agentRoot], { cwd: box.root, env: box.env });
  const joined = await box.cliAtLocal(agentRoot, 'join', box.lane, '--model', FIXTURE_MODEL, '--route', 'strong'); // strong takes the seeded items; the later joins name a family, so they register again instead of answering already joined
  assert.equal(joined.code, 0, joined.failure ?? 'a real agent joins before the credentials are revoked');
  await revokeCredential(box, state.agentTokens.coordinator.id);
  const linkBeforeMark = readFileSync(box.linkFile);
  markRevoked(box, state.agentTokens.coordinator.id); // the board knows this revocation, so the explicit token refuses at once (#2729)
  const before = (await box.cliLocal('export')).document.tables;
  const mintsBeforeExplicit = box.calls.filter(call => call.method === 'POST' && call.path === '/auth/tokens').length;
  const sendsBeforeExplicit = box.calls.filter(call => call.method === 'POST' && call.path.endsWith('/moves')).length;

  box.env.PULLBOARD_RELAY_TOKEN = state.agentTokens.coordinator.token;
  try {
    const explicit = await box.cliLocal('add', box.lane, 'explicit revoked token is not replaced');
    assert.equal(explicit.code, 1);
    assert.equal(explicit.document.error.code, 'AUTH_REQUIRED');
    assert.match(explicit.document.error.message, /supplied PULLBOARD_RELAY_TOKEN was refused/u);
    assert.match(explicit.document.error.message, /unset PULLBOARD_RELAY_TOKEN.*supply a current PULLBOARD_RELAY_TOKEN/u);
    assert.equal(box.calls.filter(call => call.method === 'POST' && call.path === '/auth/tokens').length, mintsBeforeExplicit,
      'an explicit revoked token is never replaced from the machine credential');
    assert.equal(box.calls.filter(call => call.method === 'POST' && call.path.endsWith('/moves')).length, sendsBeforeExplicit,
      'the explicit-token refusal never reaches the relay move endpoint');
    assert.deepEqual((await box.cliLocal('export')).document.tables, before,
      'an explicit revoked token is preserved as the caller identity and cannot apply a local move');
  } finally { delete box.env.PULLBOARD_RELAY_TOKEN; }
  writeFileSync(box.linkFile, linkBeforeMark, { mode: 0o600 }); // the mark was only for the explicit-token refusal; the local-first steps below start from the unmarked link

  await revokeCredential(box, state.tokenId);
  box.env.PULLBOARD_RELAY_SENDER_BACKGROUND = '0'; // The test runner's supported foreground sender mode exposes the auth diagnostic.
  const expired = await box.cli('status');
  assert.equal(expired.code, 0, expired.failure ?? 'status still reads the local board when machine authorization expires');
  assert.match((expired.document.diagnostics ?? []).join('\n'), new RegExp(`\\[AUTH_REQUIRED\\].*relay sign-in expired or was revoked for board ${state.board}.*run pullboard relay on to sign in again or pullboard relay off`, 'u'));
  const textRefusal = await box.script(`
    const { main } = await import(${JSON.stringify(box.mainURL)});
    let stdout = '', stderr = '';
    const code = await main(['join', ${JSON.stringify(box.lane)}, '--model', ${JSON.stringify(FIXTURE_MODEL)}, '--family', 'Fixture Family'], {
      cwd: ${JSON.stringify(agentRoot)}, stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } },
    });
    console.log(JSON.stringify({ code, stdout, stderr }));
  `);
  assert.equal(textRefusal.code, 0, 'the private production CLI capture completes');
  assert.equal(textRefusal.document.code, 1);
  const stderrLines = textRefusal.document.stderr.trim().split('\n');
  const refusalLines = stderrLines.filter(line => !/^next: /u.test(line));
  assert.equal(refusalLines.length, 1, 'text registration reports exactly one refusal line');
  assert.equal(stderrLines.length - refusalLines.length, 1, 'followed by the one next step every text refusal ends with (#176)');
  assert.match(refusalLines[0], new RegExp(state.board));
  assert.match(refusalLines[0], /pullboard relay on.*pullboard relay off/u);
  const rejoin = await box.cliAtLocal(agentRoot, 'join', box.lane, '--model', FIXTURE_MODEL, '--family', 'Fixture Family');
  assert.equal(rejoin.code, 1);
  assert.equal(rejoin.document.error.code, 'AUTH_REQUIRED');
  assert.equal((rejoin.document.diagnostics ?? []).length, 0, 'registration reports only its refusal, without a read fallback first');
  assert.equal(rejoin.document.error.message.split('\n').length, 1);
  assert.match(rejoin.document.error.message, new RegExp(state.board));
  assert.match(rejoin.document.error.message, /pullboard relay on.*pullboard relay off/u);

  const orderedLink = readFileSync(box.linkFile, 'utf8');
  const phone = await box.phoneSession();
  const configFile = join(box.root, 'pullboard.json');
  const originalConfig = readFileSync(configFile);
  assert.equal(relayOutboxSetting(box.root), true, 'the existing board uses the default-on local-first setting');
  commitOutboxChoice(box, false);
  assert.equal(relayOutboxSetting(box.root), false, 'the compatibility refusals below run with the explicit opt-out');
  for (const token of [state.agentTokens.coordinator.token, phone.token, undefined]) {
    const legacy = { ...JSON.parse(readFileSync(box.linkFile, 'utf8')), token };
    delete legacy.tokenId;
    delete legacy.agentTokens;
    writeFileSync(box.linkFile, JSON.stringify(legacy) + '\n', { mode: 0o600 });
    const oldRead = await assertLocalRead(box, state.board, 'status');
    assert.equal(oldRead.code, 0);
    const oldMove = await box.cliLocal('add', box.lane, 'old links cannot apply out of order');
    assert.equal(oldMove.code, 1);
    assert.equal(oldMove.document.error.code, 'AUTH_REQUIRED');
    assert.equal((oldMove.document.diagnostics ?? []).length, 0);
    assert.equal(oldMove.document.error.message.split('\n').length, 1);
    assert.match(oldMove.document.error.message, new RegExp(state.board));
    assert.match(oldMove.document.error.message, /pullboard relay on.*pullboard relay off/u);
    assert.deepEqual((await box.cliLocal('export')).document.tables, before, 'old PA, PS and tokenless links retain the local board');
  }
  writeFileSync(configFile, originalConfig);
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore: restore relay outbox setting'], { cwd: box.root, env: box.env });
  assert.equal(relayOutboxSetting(box.root), true, 'restoring the original config restores its default-on policy');
  writeFileSync(box.linkFile, orderedLink, { mode: 0o600 });

  const next = await box.cliAtLocal(agentRoot, 'next', '--build');
  assert.equal(next.code, 0, `${next.failure ?? 'next queues its claim locally while the sender cannot authenticate'}; ${JSON.stringify(next.document?.error ?? null)}`);
  // the claim comes first: it names the seeded item the relay already knows; a claim naming an item added while the relay is down is refused RELAY_OUTBOX_UNBOUND by design
  const claimId = next.document.item.item_id;

  const queued = await box.cliLocal('add', box.lane, 'local work waits for machine sign-in');
  assert.equal(queued.code, 0, queued.failure ?? 'the expired relay credential does not block the local move');
  assert.equal(queued.document.item.item_title, 'local work waits for machine sign-in');
  const queuedId = queued.document.item.item_id;
  const locallyRecorded = (await box.cliLocal('export')).document.tables;
  assert.equal(locallyRecorded.event.filter(event => event.item_id === queuedId && event.event_kind === 'add').length, 1,
    'the local add is durable exactly once while machine authorization is unavailable');
  const pending = await box.cli('status');
  assert.equal(pending.code, 0);
  assert.ok(pending.document.relay.outbox.some(move => move.operation === 'addItem'), 'the local add remains queued for ordered delivery');
  assert.ok(pending.document.relay.outbox.some(move => move.operation === 'claim'), 'the local next claim remains queued too');
  const beforeRelink = (await box.cliLocal('export')).document.tables;
  assert.equal(beforeRelink.event.filter(event => event.item_id === queuedId && event.event_kind === 'add').length, 1);
  assert.equal(beforeRelink.event.filter(event => event.item_id === claimId && event.event_kind === 'claim').length, 1);
  box.env.PULLBOARD_RELAY_SENDER_BACKGROUND = '1';
  const relink = await box.cliLocal('relay', 'on', '--url', box.origin);
  assert.equal(relink.code, 0, relink.failure ?? 'fresh person sign-in restores the machine credential and drains local work');
  const afterRelink = (await box.cliLocal('export')).document.tables;
  assert.equal(afterRelink.event.filter(event => event.item_id === queuedId && event.event_kind === 'add').length, 1,
    'replay does not duplicate the locally completed add');
  assert.equal(afterRelink.event.filter(event => event.item_id === claimId && event.event_kind === 'claim').length, 1,
    'replay does not duplicate the locally completed next claim');
  assert.equal(((await box.cli('status')).document.relay.outbox ?? []).length, 0, 'the reauthorized machine drains the queued moves');

});

test('relay off keeps a board out of auto-link [H1,H7,H16] [clause 1]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine', 'state.json');
  const machine = JSON.parse(readFileSync(machineFile, 'utf8'));
  machine.autoLink = true;
  writeFileSync(machineFile, JSON.stringify(machine) + '\n', { mode: 0o600 });

  const off = await box.cliLocal('relay', 'off');
  assert.equal(off.code, 0, off.failure ?? 'relay off always completes local unlink');
  assert.equal(existsSync(box.linkFile), false, 'relay off removes the local link immediately');
  const excluded = JSON.parse(readFileSync(machineFile, 'utf8')).excluded;
  assert.ok(excluded.includes(box.root), 'relay off durably records the local opt-out');

  const callsBeforeStatus = box.calls.length;
  const status = await box.cli('status');
  assert.equal(status.code, 0, status.failure ?? 'local status remains available after relay off');
  assert.equal(status.document.relay.linked, false, 'the auto-link pass leaves the board unlinked');
  assert.equal(box.calls.length, callsBeforeStatus, 'auto-link does not contact the relay or relink an excluded board');
  assert.ok(JSON.parse(readFileSync(machineFile, 'utf8')).excluded.includes(box.root));
});

/** Enroll one cryptographically authenticated phone through the production native and HTTP paths. */
async function enrollDeletionPhone(box) {
  const machineURL = new URL('../../../../packages/link/index.js', import.meta.url).href;
  const linked = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const pendingResult = await box.script(`
    const { beginDeviceEnrollment } = await import(${JSON.stringify(machineURL)});
    console.log(JSON.stringify(beginDeviceEnrollment(${JSON.stringify(linked.board)},
      { account: ${JSON.stringify(linked.account)}, url: ${JSON.stringify(box.origin)} })));
  `);
  assert.equal(pendingResult.code, 0, 'the native machine creates a one-use phone enrollment');
  const pending = pendingResult.document;
  const phone = await box.phoneSession();
  const keys = await createDeviceKeys();
  const value = await signDeviceEnrollment(pending.secret, { v: 1, account: pending.account, locator: pending.locator,
    deviceId: keys.deviceId, publicKey: keys.publicKey, label: 'Deletion fixture phone', createdAt: new Date().toISOString() });
  const headers = { authorization: 'Bearer ' + phone.token, 'content-type': 'application/json', 'x-pullboard-engine': String(ENGINE_VERSION) };
  const path = '/api/v1/devices/enrollments/' + pending.locator;
  assert.equal((await fetch(box.origin + path, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await fetch(box.origin + path, { method: 'PUT', headers, body: JSON.stringify(value) })).status, 200);
  const delivered = await (await fetch(box.origin + path, { headers })).json();
  const accepted = await box.script(`
    const { acceptDeviceEnrollment } = await import(${JSON.stringify(machineURL)});
    await acceptDeviceEnrollment(${JSON.stringify(delivered.enrollment)});
    console.log(JSON.stringify({ accepted: true }));
  `);
  assert.equal(accepted.code, 0, 'the native machine authenticates the returned enrollment before trusting it');
  assert.equal((await fetch(box.origin + '/api/v1/devices/' + keys.deviceId, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await fetch(box.origin + path, { method: 'DELETE', headers })).status, 200);
  return { phone, headers, deviceId: keys.deviceId };
}

/** Pair an actual independent clone and leave one enrolled phone able to approve deletion. */
async function joinedDeletionFixture(t) {
  const box = await relayClientFixture(t);
  await box.link();
  const printed = await box.cliLocal('relay', 'pair');
  assert.equal(printed.code, 0, 'the owner publishes a real one-use computer pairing code');
  const joined = await box.otherDeviceJoin(printed.document.code);
  const phone = await enrollDeletionPhone(box);
  return { box, joined, ...phone };
}

test('a joined computer adds locally after the owner deletes the relay copy [H17,E9] [clause 1]', async (t) => {
  const { box, joined, headers, deviceId } = await joinedDeletionFixture(t);
  const board = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
  const off = await box.cliLocal('relay', 'off');
  assert.equal(off.code, 0, 'the owner unlinks locally before phone approval');
  const inbox = await (await fetch(box.origin + '/api/v1/devices/' + deviceId + '/approvals', { headers })).json();
  const approval = inbox.approvals.find(entry => entry.context.action === 'delete-board' && entry.context.board === board);
  assert.ok(approval, "the real phone receives the owner's deletion request");
  const removed = await fetch(box.origin + '/api/v1/devices/approvals/' + approval.context.id + '/authorize', { method: 'POST', headers, body: '{}' });
  assert.equal(removed.status, 200, 'the phone approves deletion through the real authorization endpoint');
  assert.equal((await removed.json()).result.deleted, board);
  const added = await joined.cli('add', box.lane, 'local work survives remote deletion');
  assert.equal(added.code, 0, added.document.error ? `${added.document.error.code}: ${added.document.error.message}` : 'the joined computer adds locally after deletion');
  const diagnostics = (added.document.diagnostics ?? []).join('\n');
  assert.match(diagnostics, /relay copy.*deleted|deleted.*relay copy/u, 'the diagnostic names the deleted shared copy');
  assert.doesNotMatch(diagnostics, /sign-in expired|AUTH_REQUIRED/u, 'deletion is never mislabeled as expired sign-in');
  const exported = await joined.cli('export');
  assert.equal(exported.code, 0);
  assert.equal(exported.document.tables.item.filter(row => row.item_title === 'local work survives remote deletion').length, 1,
    'the successful local move is recorded exactly once');
  const status = await joined.cli('status');
  assert.equal(status.code, 0);
  assert.equal(status.document.relay.linked, false, 'the deleted relay copy no longer intercepts later local moves');
});

test('the owner is warned that deleting the relay copy cuts off joined computers [H17,E9] [clause 1]', async (t) => {
  const { box, joined } = await joinedDeletionFixture(t);
  const off = await box.cliLocal('relay', 'off');
  assert.equal(off.code, 0);
  assert.match(off.document.notice, /joined computer.*lose.*shared copy/u, 'the warning names the consequence before phone approval');
  assert.ok(off.document.affectedMachines.includes(joined.machine), 'the warning identifies exactly which joined computer loses the shared copy');
  assert.equal(box.auth.linkedBoards().length, 1, 'the warning is returned before the phone has approved any deletion');
});


test('an agent token cannot inventory joined computers [H17,E9] [clause 1]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const token = await box.auth.issueToken(state.token, { board: state.board, agent: 'roster-probe' });
  const response = await fetch(box.origin + '/auth/machines?board=' + state.board, {
    headers: { authorization: 'Bearer ' + token.token },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'HUMAN_REQUIRED', 'a scoped agent can never list joined computers');
});


test('another board deletion never turns this board into local mode [H17,E9] [clause 1]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const other = await box.additionalBoard('separate shared board');
  const phone = await box.phoneSession();
  const token = await box.auth.issueToken(phone.token, { board: other.id, agent: 'foreign-deleted-board' });
  const before = (await box.cliLocal('export')).document.tables;
  const removed = await fetch(box.origin + '/api/v1/boards/' + other.id, { method: 'DELETE',
    headers: { authorization: 'Bearer ' + phone.token, 'x-pullboard-engine': String(ENGINE_VERSION) } });
  assert.equal(removed.status, 200, 'the phone deletes only the independent board copy');
  box.env.PULLBOARD_RELAY_TOKEN = token.token;
  try {
    const refused = await box.cliLocal('add', box.lane, 'must stay ordered on the surviving board');
    assert.equal(refused.code, 1, 'a deletion response naming another board never permits a local move');
    assert.equal(refused.document.error.code, 'RELAY_BOARD_DELETED');
    assert.equal(existsSync(box.linkFile), true, 'the surviving board keeps its ordered link');
  } finally { delete box.env.PULLBOARD_RELAY_TOKEN; }
  const exported = await box.cliLocal('export');
  assert.equal(exported.code, 0);
  assert.deepEqual(exported.document.tables, before, 'the refused move changes no local row');
  assert.equal((await box.cli('status')).document.relay.board, state.board);
  assert.equal((await box.cliLocal('add', box.lane, 'the surviving board still syncs')).code, 0, 'ordinary ordered work remains available with its own credential');
});

test('a move pending acknowledgement when the relay copy is deleted is kept [H17,E9] [clause 1]', async t => {
 const box = await relayClientFixture(t);
 await box.link();
 const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
 const phone = await box.phoneSession();
 const firstTitle = 'locally originated move before deleted-copy lost acknowledgement';
 const result = await box.script(`
   const { main } = await import(${JSON.stringify(box.mainURL)});
   const realFetch = globalThis.fetch;
   let intercepted = false;
   globalThis.fetch = async function(input, init) {
     const response = await realFetch(input, init);
     if (!intercepted && init?.method === 'POST' && String(input).endsWith('/moves') && response.ok) {
       intercepted = true;
       const removed = await realFetch(${JSON.stringify(box.origin + '/api/v1/boards/' + state.board)}, {
         method: 'DELETE', headers: { authorization: ${JSON.stringify('Bearer ' + phone.token)}, 'x-pullboard-engine': ${JSON.stringify(String(ENGINE_VERSION))} }
       });
       if (removed.status !== 200) throw new Error('review fixture could not delete the remote copy');
       throw new TypeError('review fixture drops the already accepted move acknowledgement');
     }
     return response;
   };
   let stdout = '', stderr = '';
   const code = await main(['add', ${JSON.stringify(box.lane)}, ${JSON.stringify(firstTitle)}, '--json'], {
     cwd: ${JSON.stringify(box.root)}, stdout: {write(value) {stdout += value;}}, stderr: {write(value) {stderr += value;}}
   });
   console.log(JSON.stringify({code, intercepted, output: JSON.parse(stdout), stderr}));
 `);
 assert.equal(result.code, 0, 'the private capture process completed');
 assert.equal(result.document.intercepted, true, 'the real relay accepted the move before its acknowledgement was lost');
 assert.equal(box.auth.linkedBoards().length, 0, 'a real person-authenticated HTTP deletion completed before the transport refusal');
 const next = await box.cliLocal('add', box.lane, 'independent local work after deleted-copy lost acknowledgement');
 assert.equal(next.code, 0, 'subsequent local work succeeds');
 const exported = await box.cliLocal('export');
 assert.equal(exported.code, 0);
 assert.equal(exported.document.tables.item.filter(row => row.item_title === firstTitle).length, 1,
   'the local sender retains its earlier accepted obligation across the deletion and lost acknowledgement');
});

test('a deleted-copy pending move survives interrupted cleanup and is returned only once on retry [H17,E9] [clause 1]', async t => {
  const box = await relayClientFixture(t);
  // This case loses the acknowledgement of a move sent in the foreground, so its board sends before it applies.
  commitOutboxChoice(box, false);
  await box.link();
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const phone = await box.phoneSession();
  const firstTitle = 'pending move retained through an interrupted local deletion cleanup';
  const captured = await box.script(`
    const { main } = await import(${JSON.stringify(box.mainURL)});
    const realFetch = globalThis.fetch;
    let intercepted = false;
    globalThis.fetch = async function(input, init) {
      const response = await realFetch(input, init);
      if (!intercepted && init?.method === 'POST' && String(input).endsWith('/moves') && response.ok) {
        intercepted = true;
        const removed = await realFetch(${JSON.stringify(box.origin + '/api/v1/boards/' + state.board)}, {
          method: 'DELETE', headers: { authorization: ${JSON.stringify('Bearer ' + phone.token)}, 'x-pullboard-engine': ${JSON.stringify(String(ENGINE_VERSION))} }
        });
        if (removed.status !== 200) throw new Error('the private phone could not delete the accepted copy');
        throw new TypeError('the private fixture loses the accepted move acknowledgement');
      }
      return response;
    };
    let firstOutput = '';
    const firstCode = await main(['add', ${JSON.stringify(box.lane)}, ${JSON.stringify(firstTitle)}, '--json'], {
      cwd: ${JSON.stringify(box.root)}, stdout: {write(value) {firstOutput += value;}}, stderr: {write() {}}
    });
    const fs = await import('node:fs');
    const { syncBuiltinESMExports } = await import('node:module');
    const rename = fs.default.renameSync;
    let cleanupInterrupted = false;
    fs.default.renameSync = function(from, to) {
      if (!cleanupInterrupted && String(to).endsWith('/relay-deleted.json')) {
        cleanupInterrupted = true;
        fs.default.renameSync = rename;
        syncBuiltinESMExports();
        throw new Error('the private fixture interrupts deletion-marker persistence');
      }
      return rename(from, to);
    };
    syncBuiltinESMExports();
    let cleanupOutput = '';
    let cleanupCode;
    let cleanupError;
    try {
      cleanupCode = await main(['add', ${JSON.stringify(box.lane)}, 'new work after interrupted deletion cleanup', '--json'], {
        cwd: ${JSON.stringify(box.root)}, stdout: {write(value) {cleanupOutput += value;}}, stderr: {write() {}}
      });
    } catch (error) {
      if (error.message !== 'the private fixture interrupts deletion-marker persistence') throw error;
      cleanupError = error.message;
    } finally { fs.default.renameSync = rename; syncBuiltinESMExports(); }
    const { localRecords } = await import(${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)});
    const { openBoard } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
    const beforeCleanup = localRecords(openBoard, ${JSON.stringify(box.root)}, board => ({
      firstCount: board.db.prepare('SELECT COUNT(*) AS count FROM item WHERE item_title=?').get(${JSON.stringify(firstTitle)}).count,
      cursor: board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='relay_applied_sequence'").get()?.meta_value
    }));
    const stillLinked = fs.existsSync(${JSON.stringify(box.linkFile)});
    console.log(JSON.stringify({ firstCode, intercepted, cleanupInterrupted, cleanupCode, cleanupError, firstOutput, cleanupOutput, beforeCleanup, stillLinked }));
  `);
  assert.equal(captured.code, 0, 'the private capture completed both real CLI invocations');
  assert.equal(captured.document.intercepted, true, 'the relay accepted the original move before its reply was lost');
  assert.equal(captured.document.cleanupInterrupted, true, 'the next CLI reached the exact deletion-marker write');
  assert.equal(captured.document.cleanupError, 'the private fixture interrupts deletion-marker persistence',
    'the private fault interrupts the command at the marker boundary');
  assert.equal(box.auth.linkedBoards().length, 0, 'the real person-authenticated deletion remains complete');
  assert.equal(captured.document.stillLinked, true, 'interruption leaves the original pending link available for recovery');
  const cursor = document => document.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence')?.meta_value;
  const savedCursor = captured.document.beforeCleanup.cursor;
  assert.equal(captured.document.beforeCleanup.firstCount, 1,
    'the pending native move is durable before link cleanup can be interrupted');
  const next = await box.cliLocal('add', box.lane, 'new work after interrupted deletion cleanup');
  assert.equal(next.code, 0, 'a fresh invocation completes cleanup and different local work');
  const repeated = await box.cliLocal('add', box.lane, firstTitle);
  assert.equal(repeated.code, 0, 'the interrupted original command receives its retained native outcome');
  const exported = await box.cliLocal('export');
  assert.equal(exported.code, 0);
  assert.equal(exported.document.tables.item.filter(row => row.item_title === firstTitle).length, 1,
    'neither repeated cleanup nor the original command retry duplicates the native move');
  assert.equal(cursor(exported.document), savedCursor, 'repeated cleanup does not fabricate another relay position');
  const marker = JSON.parse(readFileSync(join(box.root, '.git', 'pullboard', 'relay-deleted.json'), 'utf8'));
  assert.equal(JSON.stringify(marker).includes(state.token), false, 'the deletion notice retains no bearer credential');
  assert.equal(marker.recovered, undefined, 'reporting the original outcome consumes its recovery pointer');
  assert.equal((await box.cliLocal('add', box.lane, firstTitle)).code, 0);
  const later = await box.cliLocal('export');
  assert.equal(later.document.tables.item.filter(row => row.item_title === firstTitle).length, 2,
    'after reporting the retained outcome, the same command can intentionally make new local work');
});
