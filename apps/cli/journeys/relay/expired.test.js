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
  const expired = await box.cliLocal('status');
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
  const pending = await box.cliLocal('status');
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
  assert.equal(((await box.cliLocal('status')).document.relay.outbox ?? []).length, 0, 'the reauthorized machine drains the queued moves');

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
  const status = await box.cliLocal('status');
  assert.equal(status.code, 0, status.failure ?? 'local status remains available after relay off');
  assert.equal(status.document.relay.linked, false, 'the auto-link pass leaves the board unlinked');
  assert.equal(box.calls.length, callsBeforeStatus, 'auto-link does not contact the relay or relink an excluded board');
  assert.ok(JSON.parse(readFileSync(machineFile, 'utf8')).excluded.includes(box.root));
});

