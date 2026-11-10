import { openBoard } from '../../../../lib/index.js';
/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  CLI,
  assert,
  existsSync,
  lstatSync,
  mkdirSync,
  privateBoardMoves,
  privateBoardPath,
  relayFixtureChild,
  relayWorkBudgetMs,
  runFixtureGit,
  store,
  teamBoard,
  test,
} from '../../../tests/fixtures/scenarios/team.js';
import { settleRelayCalls } from '../../../tests/fixtures/move.js';
import { checkoutSessionFile } from '../../../../../packages/seats/index.js';
import { repoInfo } from '../../../../../packages/git/index.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureAddArgv } from '../../../tests/fixtures/testkit.js';
import { fixtureJoinArgv } from '../../../tests/fixtures/testkit.js';

test('a private board sits beside the repo board [E11,E13,E14,E15]', { timeout: relayWorkBudgetMs(12) }, async (t) => { // budget: linked-device CLI and relay round trips, not a speed target.
  const box = await teamBoard(t, ['alice']);
  const shared = await box.cli('add', box.lane, 'repo item');
  assert.equal(shared.code, 0, 'ordinary add stays on the linked repo board');
  const repoBoardId = box.before.tables.board_meta.find(row => row.meta_key === 'board_id').meta_value;
  await settleRelayCalls(box); // the shared add's background sender may still be talking to the relay
  const callsBeforePrivate = box.calls.length;
  const local = await box.cli('add', box.lane, 'private item', '--private');
  assert.equal(local.code, 0, `private add stays available beside a linked team board: ${JSON.stringify(local.document?.error ?? null)}`);
  const privateFile = privateBoardPath(repoBoardId, box.env.PULLBOARD_HOME);
  const privateIdBoard = openBoard(privateFile);
  let privateBoardId;
  try { privateBoardId = store.boardId(privateIdBoard); } finally { store.closeBoard(privateIdBoard); }
  // The private add's CLI start may flush the shared add's pending outbox to the repo board: those calls are a fixture race, so only private-board requests count.
  const laterCalls = box.calls.slice(callsBeforePrivate);
  assert.deepEqual(laterCalls.filter(call => call.path.includes(privateBoardId)), [], 'private add makes no relay request');
  assert.deepEqual(laterCalls.filter(call => !call.path.includes(repoBoardId) && !call.path.includes(privateBoardId)), [], 'private add makes no unexpected relay request');
  assert.ok(privateFile.startsWith(box.env.PULLBOARD_HOME + '/'), 'the private board is kept under this device’s Pullboard home');
  assert.equal(lstatSync(join(box.env.PULLBOARD_HOME, 'private')).mode & 0o777, 0o700, 'the private-board root is owner-only');
  assert.equal(lstatSync(join(box.env.PULLBOARD_HOME, 'private', repoBoardId)).mode & 0o777, 0o700, 'the private board directory is owner-only');
  assert.equal(lstatSync(privateFile).mode & 0o777, 0o600, 'the private SQLite file is owner-only');
  const sessionEnv = { ...box.env, CODEX_SHELL: '1', CODEX_THREAD_ID: 'private-board-binding-fixture' };
  const decoy = join(box.root, '..', 'private-decoy');
  runFixtureGit(['worktree', 'add', '-q', '--detach', decoy, 'HEAD'], { cwd: box.root, env: box.env });
  const decoyJoined = await relayFixtureChild(decoy, sessionEnv, [...fixtureJoinArgv(CLI), box.lane, '--model', 'fixture-model', '--json']);
  assert.equal(decoyJoined.code, 0, `a first worktree takes the first repository lane ID: ${JSON.stringify(decoyJoined.document?.error ?? null)}`);
  const decoySeat = (await relayFixtureChild(decoy, sessionEnv, [CLI, 'whoami', '--json'])).document;
  const worker = join(box.root, '..', 'private-worker');
  runFixtureGit(['worktree', 'add', '-q', '--detach', worker, 'HEAD'], { cwd: box.root, env: box.env });
  const joined = await relayFixtureChild(worker, sessionEnv, [...fixtureJoinArgv(CLI), box.lane, '--model', 'fixture-model', '--json']);
  assert.equal(joined.code, 0, `another worktree joins the same repo board: ${JSON.stringify(joined.document?.error ?? null)}`);
  const repoSeat = (await relayFixtureChild(worker, sessionEnv, [CLI, 'whoami', '--json'])).document;
  assert.notEqual(repoSeat.id, decoySeat.id, 'the worker has a later ID on the repository board');
  const sessionFile = checkoutSessionFile(repoInfo(worker, { env: sessionEnv }));
  const checkoutBindingBefore = readFileSync(sessionFile, 'utf8');
  const reopened = await relayFixtureChild(worker, sessionEnv, [...fixtureAddArgv(CLI), box.lane, 'private item from another worktree', '--private', '--json']);
  assert.equal(reopened.code, 0, `another process opens the same repo’s private board: ${JSON.stringify(reopened.document?.error ?? null)}`);
  assert.equal(readFileSync(sessionFile, 'utf8'), checkoutBindingBefore, 'private-board identity does not rewrite the checkout’s repository-session binding');
  // @pullboard-board-file persistence: reopen the private board written by independent CLI processes.
  const privateBoard = openBoard(privateFile);
  try {
    const privateItems = store.listItems(privateBoard, { all: true }).sort((left, right) => left.item_id - right.item_id);
    assert.deepEqual(privateItems.map(item => item.item_title), ['private item', 'private item from another worktree']);
    assert.deepEqual(privateItems.map(item => item.item_id), [1, 2], 'local IDs persist across worktrees and processes');
    assert.notEqual(store.boardId(privateBoard), repoBoardId, 'the private board has its own immutable identity');
    const privateWorker = store.agentAt(privateBoard, worker);
    assert.ok(privateWorker, 'the second process has a private-board seat');
    assert.notEqual(privateWorker.agent_id, repoSeat.id, 'private-board agent identity is independent of the repository-board ID');
    assert.equal(privateBoard.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('private_repo_board_id').meta_value,
      repoBoardId, 'the local registration stays bound to the repo board ID');
    const reference = JSON.parse(privateBoard.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('private_board_reference').meta_value);
    assert.equal(reference.owner, 'alice', 'ordinary repo sign-in supplies the authenticated private handle login before any bulk setup');
  } finally { store.closeBoard(privateBoard); }
  const sharedExport = (await box.cli('export')).document;
  assert.equal(JSON.stringify(sharedExport).includes('private item'), false, 'shared board exports contain no private prose');

  const bobRoot = join(box.root, '..', 'bob-clone');
  runFixtureGit(['clone', '-q', box.root, bobRoot], { cwd: box.root, env: box.env });
  runFixtureGit(['remote', 'set-url', 'origin', 'git@github.com:fixture/repository.git'], { cwd: bobRoot, env: box.env });
  box.copyOwnBoardMetadata(bobRoot);
  const bobHome = join(box.root, '..', 'bob-home');
  const bobEnv = { ...box.env, HOME: bobHome, PULLBOARD_HOME: join(bobHome, '.pullboard'), PULLBOARD_MACHINE_HOME: join(bobHome, 'machine') };
  mkdirSync(join(bobEnv.PULLBOARD_HOME, 'relay-keys'), { recursive: true, mode: 0o700 });
  box.copyOwnKey(bobEnv.PULLBOARD_HOME, repoBoardId);
  box.providerState.signer = 'bob';
  const linked = await relayFixtureChild(bobRoot, bobEnv, [CLI, 'relay', 'on', '--url', box.origin, '--json']);
  box.providerState.signer = 'alice';
  assert.equal(linked.code, 0, `another team member links their own device: ${JSON.stringify(linked.document?.error ?? null)}`);
  const bobItems = await relayFixtureChild(bobRoot, bobEnv, [CLI, 'list', '--all', '--json']);
  assert.equal(bobItems.code, 0, `another member reads the shared board: ${JSON.stringify(bobItems.document?.error ?? null)}`);
  const titles = (bobItems.document?.items ?? []).map(item => item.title ?? item.item_title);
  assert.ok(titles.includes('repo item'), 'the ordinary item reaches the other member');
  assert.equal(titles.includes('private item'), false, 'the private item stays on this device');
  assert.equal(existsSync(privateBoardPath(repoBoardId, bobEnv.PULLBOARD_HOME)), false, 'another device has no local private board file');
  await privateBoardMoves(box, privateFile);
});
