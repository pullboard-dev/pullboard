/** Relay identity, expiry, permission freshness and scoped credential isolation [H8, H1]. */
import assert from 'node:assert/strict';
import { main as nativeTestMain } from '../../tests/fixtures/native.js';
import { runFixtureChild as spawnSync } from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { serveView } from '../../src/io/commands/view.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';
import { fetchPrintedViewLink } from '../../tests/fixtures/view/link.js';
import { CLI } from '../../tests/fixtures/relay/auth.js';
import { fixture } from '../../tests/fixtures/relay/auth.js';

/** Run the production CLI in this process with the fixture's isolated environment; no Node launch per call [C7]. */
function inProcessCli(box) {
  return (cwd, ...args) => runCliInProcess(args, { cwd, env: box.env });
}

/** Commit every fixture file with Git plumbing, which runs no hook: the seed is setup, and each hook run was a Node launch [C7]. */
function seedCommit(box) {
  const git = (...args) => {
    const step = spawnSync('git', args, { cwd: box.root, env: box.env, encoding: 'utf8' });
    assert.equal(step.status, 0, step.stderr);
    return step.stdout.trim();
  };
  git('add', '-A');
  const commit = git('commit-tree', git('write-tree'), '-p', 'HEAD', '-m', 'chore(test): seed fixture');
  git('update-ref', 'HEAD', commit);
}

test('cli.journeys-relay-main-offline.offline-linked-reads-use-the-local: offline linked reads use the local board, moves queue locally, and the same relay receives them when it returns [H10,H21]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const boardFile = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const beforeBytes = readFileSync(boardFile);
  const beforeTables = (await box.cliLocal('export')).document.tables;
  const beforeEvents = beforeTables.event;
  const oldEnvironment = new Map(['HOME', 'PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME']
    .map(name => [name, process.env[name]]));
  for (const name of oldEnvironment.keys()) process.env[name] = box.env[name];
  let view;
  try {
    view = await serveView({ port: 0, runCommand: nativeTestMain });
    const page = await fetchPrintedViewLink(view.url);
    assert.equal(page.status, 200, 'the real local view page remains available');
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);

    await box.stopRelay();
    const status = await box.cliLocal('status');
    const listed = await box.cliLocal('list', '--all');
    const shown = await box.cliLocal('show', '1');
    assert.equal(status.code, 0, 'status reads its local board while disconnected');
    assert.equal(listed.code, 0, 'list reads its local board while disconnected');
    assert.ok(listed.document.items.some(item => item.item_title === 'private cleanup fixture item'));
    assert.equal(shown.code, 0, 'show reads its local board while disconnected');
    assert.equal(shown.document.item_title, 'private cleanup fixture item');

    const viewKey = new URL(view.url).searchParams.get('k');
    const localBoardsUrl = new URL('/api/v1/boards', view.url);
    localBoardsUrl.searchParams.set('k', viewKey);
    const localBoardsResponse = await fetchFresh(localBoardsUrl);
    assert.equal(localBoardsResponse.status, 200, 'the local view API remains available offline');
    const localBoards = await localBoardsResponse.json();
    const localBoard = localBoards.boards.find(board => board.root === box.root);
    assert.ok(localBoard, 'the local view still lists the linked project from its local registry');
    const localStateUrl = new URL(`/api/v1/boards/${localBoard.id}/state`, view.url);
    localStateUrl.searchParams.set('k', viewKey);
    const localStateResponse = await fetchFresh(localStateUrl);
    assert.equal(localStateResponse.status, 200);
    const localState = await localStateResponse.json();
    assert.ok(localState.state.items.some(item => item.title === 'private cleanup fixture item'),
      'the local view reads the same private board contents while the relay is stopped');

    for (const args of [['add', box.lane, 'queued offline add'], ['shout', 'all', 'queued offline shout']]) {
      const queued = await box.cliLocal(...args);
      assert.equal(queued.code, 0, 'H21: an offline move returns at once and is queued, not refused');
    }
    const viewMoveUrl = new URL(`/api/v1/boards/${localBoard.id}/moves`, view.url);
    viewMoveUrl.searchParams.set('k', viewKey);
    const viewMove = await fetchFresh(viewMoveUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'add', args: { lane: box.lane, title: 'queued offline view move' } }),
    });
    assert.equal(viewMove.status, 200, 'the local view API also queues the move');
    const queuedStatus = await box.cliLocal('status');
    assert.deepEqual(queuedStatus.document.relay.outbox.map(move => move.operation), ['addItem', 'shout', 'addItem'], 'every offline move waits in order');
    const addsOf = tables => tables.event.filter(event => event.event_kind === 'add').length;
    assert.equal(addsOf((await box.cliLocal('export')).document.tables), addsOf(beforeTables) + 2, 'each queued add is on the local board at once');
    await box.restartRelay();
    const resumed = await box.cliLocal('add', box.lane, 'move after relay returns');
    assert.equal(resumed.code, 0, 'the relay resumes without relay off/on repair');
    const sent = (await box.cliLocal('status')).document.relay;
    assert.equal(sent.behind, 0, 'the queued moves reached the same relay without relay off/on repair');
    assert.equal(sent.sequence, 4, 'each queued move and the recovery move hold exactly one relay position');
  } finally {
    if (view) await view.close();
    for (const [name, value] of oldEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('cli.journeys-relay-main-offline.relay-test-js-fixture-seats-claim: clause 1: relay.test.js fixture seats claim on the strong route [C7]', async (t) => {
  const box = await relayClientFixture(t);
  symlinkSync(resolve(import.meta.dirname, '../../pullboard.js'), join(box.env.PATH, 'pullboard'));
  const laneAdded = await inProcessCli(box)(box.root, 'lane', 'add', 'fixture', '--owns', 'fixture/', '--json'); // the review lane owns no folder
  assert.equal(laneAdded.status, 0, laneAdded.stdout + laneAdded.stderr);
  seedCommit(box);
  const agentRoot = join(box.root, '..', 'strong-route-agent');
  const worktree = spawnSync('git', ['worktree', 'add', '-b', 'fixture-strong-route-agent', agentRoot, 'HEAD'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(worktree.status, 0, worktree.stderr);
  const run = inProcessCli(box);
  const item = await fileFixtureItem({ run }, box.root, { lane: 'fixture', title: 'strong route claim fixture' });
  assert.equal((await joinFixtureSeat({ run }, agentRoot, 'fixture')).code, 0, 'the fixture seat joins on the strong route');
  const claimed = await run(agentRoot, 'claim', String(item.item_id), '--no-next', '--json');
  assert.doesNotMatch(`${claimed.stdout}${claimed.stderr}`, /"ROUTE"|\[ROUTE\]|ROUTE:/, 'the claim is not refused ROUTE');
});

test('cli.journeys-relay-main-offline.a-linked-device-without-its-key: a linked device without its key reads locally and refuses moves with both repairs [H10,H17]', async (t) => {
  const box = await relayClientFixture(t);
  // The isolated PATH must install the real CLI for Git's generated hooks in the new worktree.
  symlinkSync(resolve(import.meta.dirname, '../../pullboard.js'), join(box.env.PATH, 'pullboard'));
  seedCommit(box);
  const agentRoot = join(box.root, '..', 'missing-key-agent');
  const worktree = spawnSync('git', ['worktree', 'add', '-b', 'fixture-missing-key-agent', agentRoot, 'HEAD'], {
    cwd: box.root, env: box.env, encoding: 'utf8',
  });
  assert.equal(worktree.status, 0, worktree.stderr);
  assert.equal((await joinFixtureSeat({ run: inProcessCli(box) }, agentRoot, box.lane)).code, 0, 'the real agent worktree joins its lane on the strong route');
  const prepare = await box.scriptLocal(`
    import { main } from ${JSON.stringify(box.mainURL)};
    for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
    /** Run a real CLI command from the fixture worktree and capture its JSON result. */
    async function command(cwd, args) {
      let output = '';
      const code = await main([...args, '--json'], { cwd, stdout: { isTTY: false, write: value => { output += value; } }, stderr: { write() {} }, stdin: process.stdin });
      return { code, document: JSON.parse(output) };
    }
    const asked = await command(${JSON.stringify(agentRoot)}, ['shout', 'coordinator', 'Should this fixture continue?', '--kind', 'question', '--decision']);
    process.stdout.write(JSON.stringify({ asked }));
  `);
  assert.equal(prepare.document.asked.code, 0, 'the agent creates a real open decision before its key is removed');
  const decision = prepare.document.asked.document.id;
  assert.ok(Number.isSafeInteger(decision));
  await box.link();
  const boardFile = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const beforeBytes = readFileSync(boardFile);
  const callsBefore = box.calls.length;
  assert.equal(existsSync(box.keyFile), true);
  rmSync(box.keyFile);
  assert.equal(existsSync(box.keyFile), false, 'the isolated device key is actually absent');

  const reads = await box.scriptLocal(`
    import { main } from ${JSON.stringify(box.mainURL)};
    for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
    /** Run one local read and capture its JSON document and diagnostics. */
    async function command(args) {
      let output = '';
      const code = await main([...args, '--json'], { cwd: process.cwd(), stdout: { isTTY: false, write: value => { output += value; } }, stderr: { write() {} }, stdin: process.stdin });
      return { code, document: JSON.parse(output) };
    }
    const status = await command(['status']);
    const list = await command(['list', '--all']);
    const show = await command(['show', '1']);
    const decisions = await command(['decisions']);
    process.stdout.write(JSON.stringify({ status, list, show, decisions }));
  `);
  const localReads = Object.values(reads.document);
  for (const result of localReads) {
    assert.equal(result.code, 0, JSON.stringify(result.document));
    assert.equal(result.document.diagnostics?.length, 1, 'each read gets one missing-key line despite sync before and after the command');
    assert.match(result.document.diagnostics[0], /RELAY_KEY_MISSING|board key is missing/);
    assert.match(result.document.diagnostics[0], /moves are off until the key is reachable/);
    assert.match(result.document.diagnostics[0], /run this command where the key is available, or pair this device/);
  }
  assert.ok(reads.document.list.document.items.some(item => item.item_title === 'private cleanup fixture item'), 'list returns the local item');
  assert.equal(reads.document.show.document.item_title, 'private cleanup fixture item', 'show returns the local item');
  assert.ok(reads.document.decisions.document.decisions.some(ask => ask.shout_id === decision), 'decisions returns the locally stored open question');
  assert.equal(box.calls.length, callsBefore, 'missing key is detected before any relay request');

  const moves = await box.scriptLocal(`
    import { main } from ${JSON.stringify(box.mainURL)};
    for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
    /** Run one linked move and capture its refusal document. */
    async function command(cwd, args) {
      let output = '';
      const code = await main([...args, '--json'], { cwd, stdout: { isTTY: false, write: value => { output += value; } }, stderr: { write() {} }, stdin: process.stdin });
      return { code, document: JSON.parse(output) };
    }
    const claim = await command(${JSON.stringify(agentRoot)}, ['claim', '1']);
    const shout = await command(${JSON.stringify(agentRoot)}, ['shout', 'all', 'must not be sent']);
    const answer = await command(${JSON.stringify(box.root)}, ['answer', ${JSON.stringify(String(decision))}, 'yes']);
    process.stdout.write(JSON.stringify({ claim, shout, answer }));
  `);
  for (const result of Object.values(moves.document)) {
    assert.equal(result.code, 1);
    assert.equal(result.document.error.code, 'RELAY_KEY_MISSING');
    assert.match(result.document.error.message, /board key is missing/);
    assert.match(result.document.error.message, /run this command where the key is available, or pair this device/);
  }
  assert.deepEqual(readFileSync(boardFile), beforeBytes, 'reads and refused moves leave the local board unchanged');
  assert.equal(box.calls.length, callsBefore, 'no read or refused move reaches the relay');
});

test('cli.journeys-relay-main-offline.a-linked-device-with-an-unreadable: a linked device with an unreadable key reads locally and refuses moves with both repairs [H10,H17]', async (t) => {
  const box = await relayClientFixture(t);
  // The isolated PATH must install the real CLI for Git's generated hooks in the new worktree.
  symlinkSync(resolve(import.meta.dirname, '../../pullboard.js'), join(box.env.PATH, 'pullboard'));
  seedCommit(box);
  const agentRoot = join(box.root, '..', 'missing-key-agent');
  const worktree = spawnSync('git', ['worktree', 'add', '-b', 'fixture-missing-key-agent', agentRoot, 'HEAD'], {
    cwd: box.root, env: box.env, encoding: 'utf8',
  });
  assert.equal(worktree.status, 0, worktree.stderr);
  assert.equal((await joinFixtureSeat({ run: inProcessCli(box) }, agentRoot, box.lane)).code, 0, 'the real agent worktree joins its lane on the strong route');
  const prepare = await box.scriptLocal(`
    import { main } from ${JSON.stringify(box.mainURL)};
    for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
    /** Run a real CLI command from the fixture worktree and capture its JSON result. */
    async function command(cwd, args) {
      let output = '';
      const code = await main([...args, '--json'], { cwd, stdout: { isTTY: false, write: value => { output += value; } }, stderr: { write() {} }, stdin: process.stdin });
      return { code, document: JSON.parse(output) };
    }
    const asked = await command(${JSON.stringify(agentRoot)}, ['shout', 'coordinator', 'Should this fixture continue?', '--kind', 'question', '--decision']);
    process.stdout.write(JSON.stringify({ asked }));
  `);
  assert.equal(prepare.document.asked.code, 0, 'the agent creates a real open decision before its key is removed');
  const decision = prepare.document.asked.document.id;
  assert.ok(Number.isSafeInteger(decision));
  await box.link();
  const boardFile = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const beforeBytes = readFileSync(boardFile);
  const callsBefore = box.calls.length;
  assert.equal(existsSync(box.keyFile), true);
  chmodSync(box.keyFile, 0o000);
  t.after(() => { if (existsSync(box.keyFile)) chmodSync(box.keyFile, 0o600); });
  assert.throws(() => readFileSync(box.keyFile), { code: 'EACCES' }, 'the real key file is denied to this shell');

  const reads = await box.scriptLocal(`
    import { main } from ${JSON.stringify(box.mainURL)};
    for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
    /** Run one local read and capture its JSON document and diagnostics. */
    async function command(args) {
      let output = '';
      try {
        const code = await main([...args, '--json'], { cwd: process.cwd(), stdout: { isTTY: false, write: value => { output += value; } }, stderr: { write() {} }, stdin: process.stdin });
        return { code, document: JSON.parse(output) };
      } catch (error) {
        return { code: error.code, document: { thrown: error.message } };
      }
    }
    const status = await command(['status']);
    const list = await command(['list', '--all']);
    const show = await command(['show', '1']);
    const decisions = await command(['decisions']);
    process.stdout.write(JSON.stringify({ status, list, show, decisions }));
  `);
  const localReads = Object.values(reads.document);
  for (const result of localReads) {
    assert.equal(result.code, 0, JSON.stringify(result.document));
    assert.equal(result.document.diagnostics?.length, 1, 'each read gets one unreadable-key line despite sync before and after the command');
    assert.match(result.document.diagnostics[0], /board key is unreadable in this shell \(EACCES\)/);
    assert.match(result.document.diagnostics[0], /moves are off until the key is reachable/);
    assert.match(result.document.diagnostics[0], /run this command where the key is available, or pair this device/);
  }
  assert.ok(reads.document.list.document.items.some(item => item.item_title === 'private cleanup fixture item'), 'list returns the local item');
  assert.equal(reads.document.show.document.item_title, 'private cleanup fixture item', 'show returns the local item');
  assert.ok(reads.document.decisions.document.decisions.some(ask => ask.shout_id === decision), 'decisions returns the locally stored open question');
  assert.equal(box.calls.length, callsBefore, 'unreadable key is detected before any relay request');

  const moves = await box.scriptLocal(`
    import { main } from ${JSON.stringify(box.mainURL)};
    for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
    /** Run one linked move and capture its refusal document. */
    async function command(cwd, args) {
      let output = '';
      try {
        const code = await main([...args, '--json'], { cwd, stdout: { isTTY: false, write: value => { output += value; } }, stderr: { write() {} }, stdin: process.stdin });
        return { code, document: JSON.parse(output) };
      } catch (error) {
        return { code: error.code, document: { thrown: error.message } };
      }
    }
    const claim = await command(${JSON.stringify(agentRoot)}, ['claim', '1']);
    const shout = await command(${JSON.stringify(agentRoot)}, ['shout', 'all', 'must not be sent']);
    const answer = await command(${JSON.stringify(box.root)}, ['answer', ${JSON.stringify(String(decision))}, 'yes']);
    process.stdout.write(JSON.stringify({ claim, shout, answer }));
  `);
  for (const result of Object.values(moves.document)) {
    assert.equal(result.code, 1);
    assert.equal(result.document.error.code, 'RELAY_KEY_MISSING');
    assert.match(result.document.error.message, /board key is unreadable in this shell \(EACCES\)/);
    assert.match(result.document.error.message, /run this command where the key is available, or pair this device/);
  }
  assert.deepEqual(readFileSync(boardFile), beforeBytes, 'reads and refused moves leave the local board unchanged');
  assert.equal(box.calls.length, callsBefore, 'no read or refused move reaches the relay');
});

// These real-protocol cases live outside the near-cap relay fixture file.
import {
  deletedCopyRelinks,
  relayOnClearsExclusion,
  assertPersonUnlinkHistory,
} from '../../tests/fixtures/relay/exclusion.js';
test('cli.journeys-relay-main-offline.a-deleted-relay-copy-relinks-rather: a deleted relay copy relinks rather than excluding the board [H5,H17]', deletedCopyRelinks);
test('cli.journeys-relay-main-offline.relay-on-clears-an-exclusion-and: relay on clears an exclusion and names it [H5,H17,B26]', relayOnClearsExclusion);
