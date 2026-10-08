/** Private end-to-end proof for ordered agent enrollment and scoped relay credentials [H2,H9,A4]. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { claim as claimStoredItem, closeBoard, openBoard, register as registerStoredAgent, submit as submitStoredItem } from '../src/board.js';
import { serveApi } from '../src/api.js';
import { main } from '../src/cli.js';
import { decodeBoardKey, unseal } from '../src/seal.js';
import { frozenCriterion, parseSpec } from '../src/spec.js';
import { relayClientFixture } from './relay-client-fixture.js';

/** Invoke one real CLI command without retaining stderr or exposing private command output. */
function runCli(root, env, cli, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cli, ...args, '--json'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    child.stderr.resume();
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error('private agent CLI exceeded its deadline'));
      try { resolveResult({ code, document: JSON.parse(stdout) }); }
      catch { reject(new Error(`private agent CLI ${args[0]} did not return JSON (exit ${code ?? 'signal'})`)); }
    });
  });
}

/** Run Git in a private fixture and keep all diagnostics credential-free. */
function git(root, env, args) {
  const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `private Git fixture ${args[0]} succeeds: ${result.stderr}`);
}

/** Return private Git output for a structural assertion without surfacing command diagnostics. */
function gitText(root, env, args) {
  const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `private Git fixture ${args[0]} succeeds`);
  return result.stdout;
}

/** Read durable local event attribution without opening a writable SQLite handle. */
function nativeEvents(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT event_by, event_kind, item_id FROM event ORDER BY event_id').all(); }
  finally { db.close(); }
}

/** Read durable verdict identity without opening a writable SQLite handle. */
function nativeVerdicts(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT verdict_by, verdict_decision, item_id, verdict_commit FROM verdict ORDER BY verdict_id').all(); }
  finally { db.close(); }
}

/** Read only the canonical registered identity for a private worktree path. */
function registeredAgent(path, worktree) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT agent_id FROM agent WHERE agent_path = ?').get(worktree)?.agent_id ?? null; }
  finally { db.close(); }
}

/** Load a cached scoped token for private transport setup without writing it to diagnostics. */
function scopedToken(linkFile, agent) {
  return JSON.parse(readFileSync(linkFile, 'utf8')).agentTokens[agent].token;
}

/** Assert a response contains only metadata and none of the fixture's private credentials. */
function assertMetadataOnly(value, credentials, message) {
  const serialized = JSON.stringify(value);
  for (const credential of credentials) assert.equal(serialized.includes(credential), false, message);
  for (const row of value.tokens ?? []) assert.equal(Object.hasOwn(row, 'token'), false, message);
}

test('ordered agent joins mint scoped tokens and retain authenticated native actors [H2,H9]', async (t) => {
  const box = await relayClientFixture(t);
  const cli = join(dirname(fileURLToPath(import.meta.url)), '../bin/pullboard.js');
  const shim = join(box.env.PATH, 'pullboard');
  writeFileSync(shim, `#!/bin/sh\nexec node "${cli}" "$@"\n`, { mode: 0o700 });
  chmodSync(shim, 0o700);
  const boardFile = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const oneItem = await box.cli('add', box.lane, 'agent one private review', '--criterion', 'the first verifier records its own decision');
  const twoItem = await box.cli('add', box.lane, 'agent two private review', '--criterion', 'the second verifier records its own decision');
  const workItem = await box.cli('add', box.lane, 'token-only agent work');
  assert.equal(oneItem.code, 0);
  assert.equal(twoItem.code, 0);
  assert.equal(workItem.code, 0);

  git(box.root, box.env, ['add', '-A']);
  git(box.root, box.env, ['commit', '-q', '-m', 'test: prepare private agent fixture']);
  const submittedHead = gitText(box.root, box.env, ['rev-parse', 'HEAD']).trim();
  const submittedTree = gitText(box.root, box.env, ['rev-parse', 'HEAD^{tree}']).trim();
  const seed = openBoard(boardFile);
  try {
    const spec = parseSpec(readFileSync(join(box.root, 'SPEC.md'), 'utf8'));
    const freezer = (item) => frozenCriterion(spec, item);
    for (const [row, builderPath] of [[oneItem.document.item, '/private/relay-builder-one'], [twoItem.document.item, '/private/relay-builder-two']]) {
      const builder = registerStoredAgent(seed, { lane: box.lane, path: builderPath });
      claimStoredItem(seed, row.item_id, { agentId: builder, lane: box.lane, leaseMs: 60 * 60 * 1000, freeze: freezer, head: submittedHead });
      submitStoredItem(seed, row.item_id, { agentId: builder, commit: submittedHead, tree: submittedTree });
    }
  } finally { closeBoard(seed); }
  const firstRoot = join(dirname(box.root), 'agent-one');
  const secondRoot = join(dirname(box.root), 'agent-two');
  git(box.root, box.env, ['worktree', 'add', '-q', '-b', 'core/private-agent-one', firstRoot, 'HEAD']);
  git(box.root, box.env, ['worktree', 'add', '-q', '-b', 'core/private-agent-two', secondRoot, 'HEAD']);

  await box.link();
  const firstStart = box.calls.length;
  const firstJoin = await runCli(firstRoot, box.env, cli, ['join', box.lane, '--family', 'codex-fixture']);
  assert.equal(firstJoin.code, 0, 'the first worktree joins through the real linked CLI');
  const firstAgent = firstJoin.document.agent;
  const firstCalls = box.calls.slice(firstStart);
  const firstRegistration = firstCalls.findIndex((call) => call.method === 'POST' && call.path.endsWith('/moves'));
  const firstMint = firstCalls.findIndex((call) => call.method === 'POST' && call.path === '/auth/tokens');
  assert.ok(firstRegistration >= 0 && firstMint > firstRegistration, 'the first token is minted after ordered registration');

  const secondStart = box.calls.length;
  const secondJoin = await runCli(secondRoot, box.env, cli, ['join', box.lane, '--family', 'codex-fixture']);
  assert.equal(secondJoin.code, 0, 'the second worktree joins through the real linked CLI');
  const secondAgent = secondJoin.document.agent;
  const secondCalls = box.calls.slice(secondStart);
  const secondRegistration = secondCalls.findIndex((call) => call.method === 'POST' && call.path.endsWith('/moves'));
  const secondMint = secondCalls.findIndex((call) => call.method === 'POST' && call.path === '/auth/tokens');
  assert.ok(secondRegistration >= 0 && secondMint > secondRegistration, 'the second token is minted after ordered registration');
  assert.notEqual(firstAgent, secondAgent);

  const firstToken = scopedToken(box.linkFile, firstAgent);
  const secondToken = scopedToken(box.linkFile, secondAgent);
  const list = await box.cli('relay', 'tokens');
  assert.equal(list.code, 0);
  assert.deepEqual(list.document.tokens.map((row) => row.agent).sort(), [firstAgent, secondAgent].sort());
  const personState = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const boardKey = readFileSync(box.keyFile, 'utf8').trim();
  assertMetadataOnly(list.document, [firstToken, secondToken, personState.token, boardKey], 'CLI inventory exposes only scoped token metadata');
  const firstTokenRow = list.document.tokens.find((row) => row.agent === firstAgent);
  const secondTokenRow = list.document.tokens.find((row) => row.agent === secondAgent);
  assert.ok(firstTokenRow?.id && secondTokenRow?.id);

  const localApi = await serveApi({
    runCommand: main,
    projects: () => [{ root: box.root, name: 'private relay fixture', project: 'fixture/repository', added: '2026-10-07T00:00:00.000Z' }],
  });
  t.after(() => localApi.close());
  const tokenUrl = new URL(`/api/v1/boards/${personState.board}/tokens`, localApi.url);
  tokenUrl.searchParams.set('k', new URL(localApi.url).searchParams.get('k'));
  const apiHeaders = { 'content-type': 'application/json' };
  const apiListResponse = await fetch(tokenUrl, { headers: apiHeaders });
  assert.equal(apiListResponse.status, 200, 'local API reads the real relay token inventory');
  const apiList = await apiListResponse.json();
  assert.deepEqual(apiList.tokens.map((row) => row.agent).sort(), [firstAgent, secondAgent].sort());
  assertMetadataOnly(apiList, [firstToken, secondToken, personState.token, boardKey], 'local API exposes only token metadata');

  const realGit = realpathSync(join(box.env.PATH, 'git'));
  const pushLog = join(dirname(box.root), 'private-git-push.log');
  unlinkSync(join(box.env.PATH, 'git'));
  writeFileSync(join(box.env.PATH, 'git'), `#!/bin/sh\nif [ "$1" = push ]; then printf 'blocked\\n' >> "${pushLog}"; exit 1; fi\nexec "${realGit}" "$@"\n`, { mode: 0o700 });
  chmodSync(join(box.env.PATH, 'git'), 0o700);
  const deniedPush = spawnSync('git', ['push'], { cwd: firstRoot, env: box.env, encoding: 'utf8' });
  assert.equal(deniedPush.status, 1, 'the private fixture refuses every Git push before a remote can be contacted');
  assert.equal(readFileSync(pushLog, 'utf8'), 'blocked\n', 'the refusing Git shim records the attempted push without arguments');

  const firstVerify = await runCli(firstRoot, { ...box.env, PULLBOARD_RELAY_TOKEN: firstToken }, cli,
    ['verify', String(oneItem.document.item.item_id), 'accept', '--note', 'checked the private submitted proof']);
  assert.equal(firstVerify.code, 0, `the first agent gives an ACCEPT verdict using only its scoped token (${firstVerify.document.error?.code ?? 'no refusal'})`);
  const secondVerify = await runCli(secondRoot, { ...box.env, PULLBOARD_RELAY_TOKEN: secondToken }, cli,
    ['verify', String(twoItem.document.item.item_id), 'accept', '--note', 'checked the other private submitted proof']);
  assert.equal(secondVerify.code, 0, `the second agent gives an ACCEPT verdict using only its scoped token (${secondVerify.document.error?.code ?? 'no refusal'})`);

  const revoke = await box.cli('relay', 'revoke', firstTokenRow.id);
  assert.equal(revoke.code, 0, 'CLI revokes one listed opaque token id');
  const apiRevokeResponse = await fetch(tokenUrl, {
    method: 'POST', headers: apiHeaders, body: JSON.stringify({ id: firstTokenRow.id }),
  });
  assert.equal(apiRevokeResponse.status, 200, 'local API accepts the opaque id-only revocation body');
  const apiRevoke = await apiRevokeResponse.json();
  assert.equal(apiRevoke.id, firstTokenRow.id);
  assert.equal(apiRevoke.revoked, true);
  assertMetadataOnly(apiRevoke, [firstToken, secondToken, personState.token, boardKey], 'local API revocation response contains no credential');

  // Capture authenticated journal records before a person command checkpoints their prefix.
  const remoteState = await fetch(`${box.origin}/api/v1/boards/${personState.board}/state`, {
    headers: { authorization: `Bearer ${secondToken}` },
  });
  assert.equal(remoteState.status, 200, 'the second scoped token can read the sealed relay snapshot');
  const relayState = await remoteState.json();
  const remote = await fetch(`${box.origin}/api/v1/boards/${personState.board}/events?after=${relayState.state.sequence}`, {
    headers: { authorization: `Bearer ${secondToken}` },
  });
  assert.equal(remote.status, 200, 'the second scoped token can read the ordered relay events');
  const remoteEvents = (await remote.json()).events;

  const cachedMintCount = box.calls.filter((call) => call.method === 'POST' && call.path === '/auth/tokens').length;
  const beforeCachedRefusal = nativeEvents(boardFile);
  const cachedRefusal = await runCli(firstRoot, box.env, cli, ['shout', 'all', 'revoked cache must stay revoked']);
  assert.equal(cachedRefusal.code, 1, 'a cached revoked credential refuses even while the person session remains valid');
  assert.equal(cachedRefusal.document.error.code, 'AUTH_REQUIRED');
  assert.deepEqual(nativeEvents(boardFile), beforeCachedRefusal, 'revoked cached credentials cannot write native board events');
  assert.equal(box.calls.filter((call) => call.method === 'POST' && call.path === '/auth/tokens').length, cachedMintCount,
    'a valid person session never silently re-mints its revoked agent cache');

  const linkAfterRevoke = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const personRevoked = await fetch(box.origin + '/auth/tokens/revoke', {
    method: 'POST', headers: { authorization: `Bearer ${linkAfterRevoke.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: linkAfterRevoke.tokenId }),
  });
  assert.equal(personRevoked.status, 200, 'the private person session is revoked before token-only access');
  const deadSession = await fetch(box.origin + '/auth/session', { headers: { authorization: `Bearer ${linkAfterRevoke.token}` } });
  assert.equal(deadSession.status, 401);
  assert.equal((await deadSession.json()).error.code, 'AUTH_REQUIRED');

  const mintCount = box.calls.filter((call) => call.method === 'POST' && call.path === '/auth/tokens').length;
  const firstEnv = { ...box.env, PULLBOARD_RELAY_TOKEN: firstToken };
  const revokedMove = await runCli(firstRoot, firstEnv, cli, ['add', box.lane, 'must not use revoked token']);
  assert.equal(revokedMove.code, 1);
  assert.equal(revokedMove.document.error.code, 'AUTH_REQUIRED');
  assert.equal(box.calls.filter((call) => call.method === 'POST' && call.path === '/auth/tokens').length, mintCount,
    'a revoked credential is not silently re-minted');

  const secondEnv = { ...box.env, PULLBOARD_RELAY_TOKEN: secondToken };
  const tokenOnlyRead = await runCli(secondRoot, secondEnv, cli, ['list', '--all']);
  assert.equal(tokenOnlyRead.code, 0, 'the other agent reads through its scoped token after person revocation');
  const tokenOnlyWrite = await runCli(secondRoot, secondEnv, cli, ['claim', String(workItem.document.item.item_id)]);
  assert.equal(tokenOnlyWrite.code, 0, 'the other agent writes through its scoped token after person revocation');

  const native = nativeEvents(boardFile);
  assert.ok(native.some((row) => row.event_by === secondAgent && row.event_kind === 'claim' && row.item_id === workItem.document.item.item_id),
    'the second agent claim is recorded in the native SQLite event log');
  const verdicts = nativeVerdicts(boardFile);
  assert.ok(verdicts.some((row) => row.verdict_by === firstAgent && row.verdict_decision === 'ACCEPT' && row.item_id === oneItem.document.item.item_id && row.verdict_commit === submittedHead),
    'the first submitted-item ACCEPT is recorded under the first agent in native SQLite');
  assert.ok(verdicts.some((row) => row.verdict_by === secondAgent && row.verdict_decision === 'ACCEPT' && row.item_id === twoItem.document.item.item_id && row.verdict_commit === submittedHead),
    'the second submitted-item ACCEPT is recorded under the second agent in native SQLite');

  const otherBoard = (personState.board[0] === '0' ? '1' : '0') + personState.board.slice(1);
  const crossBoard = await fetch(`${box.origin}/api/v1/boards/${otherBoard}/events?after=0`, {
    headers: { authorization: `Bearer ${secondToken}` },
  });
  assert.equal(crossBoard.status, 403, 'an agent token cannot cross to another board');
  assert.equal((await crossBoard.json()).error.code, 'TOKEN_BOARD');

  assert.ok(remoteEvents.some((event) => event.sender?.kind === 'agent' && event.sender.agent === firstAgent),
    'relay metadata attributes the first native move to its authenticated agent');
  assert.ok(remoteEvents.some((event) => event.sender?.kind === 'agent' && event.sender.agent === secondAgent),
    'relay metadata attributes the second native move to its authenticated agent');

  const openedEvents = await Promise.all(remoteEvents.map(async (record) => ({ record, opened: JSON.parse(new TextDecoder().decode(await unseal(
    decodeBoardKey(boardKey), Buffer.from(record.sealed, 'base64url'),
    { boardId: personState.board, kind: record.kind, sequence: record.event_id },
  ))) })));
  assert.ok(openedEvents.some(({ record, opened }) => record.sender?.agent === firstAgent && opened.operation === 'verify' && opened.args[0] === oneItem.document.item.item_id),
    'the relay carries the first agent verification under its authenticated sender metadata');
  assert.ok(openedEvents.some(({ record, opened }) => record.sender?.agent === secondAgent && opened.operation === 'verify' && opened.args[0] === twoItem.document.item.item_id),
    'the relay carries the second agent verification under its authenticated sender metadata');

  const firstEventRecord = openedEvents.find((event) => event.record.sender?.agent === firstAgent)?.opened;
  assert.equal(firstEventRecord.actor, firstAgent, 'the authenticated relay principal matches the sealed native actor');
  assertMetadataOnly(remoteEvents.map(({ event_id, event_at, kind, sender }) => ({ event_id, event_at, kind, sender })),
    [firstToken, secondToken, personState.token, boardKey], 'relay event metadata never exposes credentials');
});

test('a token mint failure after registration preserves the agent for one clean retry [H2,H9]', async (t) => {
  const box = await relayClientFixture(t);
  const cli = join(dirname(fileURLToPath(import.meta.url)), '../bin/pullboard.js');
  const shim = join(box.env.PATH, 'pullboard');
  writeFileSync(shim, `#!/bin/sh\nexec node "${cli}" "$@"\n`, { mode: 0o700 });
  chmodSync(shim, 0o700);
  const boardFile = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const item = await box.cli('add', box.lane, 'retry registered agent token fixture');
  assert.equal(item.code, 0);
  git(box.root, box.env, ['add', '-A']);
  git(box.root, box.env, ['commit', '-q', '-m', 'test: prepare token retry fixture']);
  await box.link();
  box.failTokenMints(1);

  const firstStart = box.calls.length;
  const failedCreate = await box.cli('worktree', box.lane, '--family', 'codex-fixture');
  assert.equal(failedCreate.code, 1, 'the injected token service failure is reported after the real worktree registration');
  const firstCalls = box.calls.slice(firstStart);
  assert.equal(firstCalls.filter((call) => call.method === 'POST' && call.path === '/auth/tokens').length, 1);
  const agentRoot = join(dirname(box.root), `${basename(box.root)}-${box.lane}-1`);
  const agent = registeredAgent(boardFile, agentRoot);
  assert.ok(agent, 'successful ordered registration remains canonical after token mint failure');
  assert.equal(existsSync(agentRoot), true, 'the registered worktree is retained for retry');
  const worktrees = gitText(box.root, box.env, ['worktree', 'list', '--porcelain']);
  assert.ok(worktrees.includes(agentRoot), 'Git still records the retained worktree');
  assert.match(worktrees, new RegExp(`branch refs/heads/${box.lane}/1`), 'the registered branch is retained too');
  const joinRows = nativeEvents(boardFile).filter((row) => row.event_by === agent && row.event_kind === 'join');
  assert.equal(joinRows.length, 1, 'the failed mint does not undo or duplicate ordered registration');

  const retryStart = box.calls.length;
  const retry = await runCli(agentRoot, box.env, cli, ['join', box.lane, '--family', 'codex-fixture']);
  assert.equal(retry.code, 0, 'the same registered worktree can retry token minting');
  assert.equal(retry.document.agent, agent);
  assert.equal(box.calls.slice(retryStart).filter((call) => call.method === 'POST' && call.path === '/auth/tokens').length, 1);
  assert.equal(nativeEvents(boardFile).filter((row) => row.event_by === agent && row.event_kind === 'join').length, 1);

  const linkState = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.deepEqual(Object.keys(linkState.agentTokens), [agent], 'the private link cache holds one usable token for the registered agent');
  const token = scopedToken(box.linkFile, agent);
  const listed = await box.cli('relay', 'tokens');
  assert.equal(listed.code, 0);
  assert.deepEqual(listed.document.tokens.map((row) => row.agent), [agent]);
  assertMetadataOnly(listed.document, [token, linkState.token], 'retry inventory exposes metadata only');
  const usable = await runCli(agentRoot, { ...box.env, PULLBOARD_RELAY_TOKEN: token }, cli,
    ['claim', String(item.document.item.item_id)]);
  assert.equal(usable.code, 0, 'the single token from the successful retry authorizes an agent action');
});
