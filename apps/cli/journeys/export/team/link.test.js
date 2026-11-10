/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  CLI,
  assert,
  childProcess,
  existsSync,
  memberDevice,
  mkdirSync,
  personSession,
  randomBytes,
  readdirSync,
  relayFixtureChild,
  relayWorkBudgetMs,
  rmSync,
  runFixtureChild,
  runFixtureGit,
  store,
  symlinkSync,
  teamBoard,
  test,
  withBoard,
} from '../../../tests/fixtures/scenarios/team.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('a clone of a linked repo joins its board; a member device hands over the key [E1,E12,E17]', { timeout: relayWorkBudgetMs(20) }, async (t) => { // budget: hang ceiling for four devices' real CLI runs, ssh-keygen and relay calls; not a speed target.
  const box = await teamBoard(t, ['alice']);
  // Each computer has OpenSSH's ssh-keygen, and reads SSH keys from the stand-in GitHub.
  const tools = join(box.root, '..', 'tools-bin');
  mkdirSync(tools, { mode: 0o700 });
  for (const name of readdirSync(box.env.PATH)) symlinkSync(join(box.env.PATH, name), join(tools, name));
  const sshKeygen = childProcess.spawnSync('sh', ['-c', 'command -v ssh-keygen'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(sshKeygen, 'the test machine has OpenSSH');
  symlinkSync(sshKeygen, join(tools, 'ssh-keygen'));
  Object.assign(box.env, { PATH: tools, PULLBOARD_GITHUB_API: box.providerOrigin });
  const aliceKey = join(box.root, '..', 'alice-handover-key');
  assert.equal(runFixtureChild('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', aliceKey], { encoding: 'utf8' }).status, 0);
  box.env.PULLBOARD_SSH_KEY = aliceKey;
  const alicePublic = readFileSync(aliceKey + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' ');
  box.providerState.sshKeys = { alice: [alicePublic] };
  const link = JSON.parse(box.readLink());
  const config = join(box.root, 'pullboard.json');
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).relay?.board, link.board, 'relay on writes the board’s id into pullboard.json');
  assert.equal((await box.cli('add', box.lane, 'Health endpoint')).code, 0);

  // S5: a clone made before pullboard.json named the board links no second board for the repository.
  const early = memberDevice(t, box, 'bob-early');
  assert.equal((await early.cli('init')).code, 0);
  assert.equal((await early.cli('add', box.lane, 'Health endpoint')).code, 0);
  box.providerState.signer = 'bob';
  const split = await early.cli('relay', 'on', '--url', box.origin);
  assert.equal(split.document?.error?.code, 'BOARD_REPO_LINKED', `the relay refuses a second board for the repository: ${JSON.stringify(split.document?.error ?? null)}`);
  assert.match(split.document.error.message + ' ' + split.document.error.next, new RegExp(link.board + '[\\s\\S]*pullboard.json'), 'the refusal names the board and where a clone finds it');
  assert.equal(box.auth.linkedBoards().length, 1, 'the relay holds one board for the repository');
  assert.equal(existsSync(join(early.root, '.git', 'pullboard', 'relay.json')), false, 'the refused clone keeps no half-made link');

  // Once pullboard.json names the board, that clone keeps its own work rather than hide it under the team board.
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  runFixtureGit(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'chore: name the relay board'], { cwd: box.root, env: box.env });
  rmSync(join(early.root, 'pullboard.json')); // the clone's own init wrote it before the repository carried one
  runFixtureGit(['pull', '-q', '--no-rebase', box.root, 'HEAD'], { cwd: early.root, env: early.env });
  const kept = await early.cli('relay', 'on', '--url', box.origin);
  assert.equal(kept.document?.error?.code, 'RELAY_JOIN_NOT_EMPTY', `a clone with work of its own is not joined over it: ${JSON.stringify(kept.document?.error ?? null)}`);
  assert.equal(box.auth.linkedBoards().length, 1);

  const members = await box.cli('relay', 'members', 'set', 'bob');
  assert.equal(members.code, 0, `alice publishes a real signed member list: ${members.stderr}`);
  assert.deepEqual(members.document.members, ['bob']);

  // E17: a device key signed by an SSH key that is not on bob's GitHub account gets no board key.
  box.providerState.sshKeys = { alice: [alicePublic], bob: [] };
  const stray = memberDevice(t, box, 'bob-stray');
  assert.equal((await stray.cli('init')).code, 0);
  stray.sshKey();
  const strayOn = stray.start('relay', 'on', '--url', box.origin);
  assert.equal(await strayOn.said('no member device is online'), true, 'with no member online the new device says so and waits');
  assert.equal((await box.cli('status')).code, 0, 'alice’s computer comes online');
  const refused = await strayOn.closed;
  assert.equal(refused.document?.error?.code, 'RELAY_KEY_VOUCH', `the member device refuses a key no GitHub SSH key vouches for: ${refused.stderr}`);
  assert.equal(existsSync(join(stray.env.PULLBOARD_HOME, 'relay-keys', link.board + '.key')), false, 'the stray device holds no board key');

  // E17: bob's new device, its key on his GitHub account, joins once a member device is online.
  const fresh = memberDevice(t, box, 'bob-new');
  assert.equal((await fresh.cli('init')).code, 0);
  box.providerState.sshKeys = { alice: [alicePublic], bob: [fresh.sshKey()] };
  const freshOn = fresh.start('relay', 'on', '--url', box.origin);
  assert.equal(await freshOn.said('no member device is online'), true, 'the new device says no member is online and waits');
  assert.equal((await box.cli('status')).code, 0, 'alice’s computer comes online and hands the key over');
  const joined = await freshOn.closed;
  box.providerState.signer = 'alice';
  assert.equal(joined.code, 0, `relay on in the clone joins the board: ${joined.stderr}; ${JSON.stringify(joined.document?.error ?? null)}`);
  assert.equal(JSON.parse(readFileSync(join(fresh.root, '.git', 'pullboard', 'relay.json'), 'utf8')).board, link.board, 'the clone works on the board pullboard.json names');
  assert.equal(box.auth.linkedBoards().length, 1, 'joining never links another board');
  const listed = await fresh.cli('list', '--all');
  assert.ok(listed.document.items.some((item) => (item.title ?? item.item_title) === 'Health endpoint'), 'the joined clone reads the team board');
  const bobLink = JSON.parse(readFileSync(join(fresh.root, '.git', 'pullboard', 'relay.json'), 'utf8'));
  assert.equal(bobLink.agentTokens?.coordinator, undefined, 'list membership does not create person coordinator authority');
  const coordinatorPath = withBoard(box.root, board => store.listAgents(board).find(agent => agent.agent_id === 'coordinator').agent_path);
  const bobWork = fresh.root + '-lane';
  runFixtureGit(['worktree', 'add', '--detach', bobWork, 'HEAD'], { cwd: fresh.root, env: fresh.env });
  const bobCli = (...args) => relayFixtureChild(bobWork, fresh.env, [CLI, ...args, '--json']);
  const bobJoined = await bobCli('join', box.lane, '--model', 'Fixture Model');
  assert.equal(bobJoined.code, 0, `the member registers an ordinary lane seat: ${JSON.stringify(bobJoined.document?.error ?? null)}`);
  const freshAdd = await bobCli('add', box.lane, 'From bob’s new computer');
  assert.equal(freshAdd.code, 0, `the joined clone moves on the team board: ${JSON.stringify(freshAdd.document?.error ?? null)}`);
  assert.ok((await box.cli('export')).document.tables.item.some((item) => item.item_title === 'From bob’s new computer'), 'one board, one order: alice reads bob’s move');
  assert.equal(withBoard(box.root, board => store.listAgents(board).find(agent => agent.agent_id === 'coordinator').agent_path), coordinatorPath, 'the ordinary member leaves Alice’s coordinator holder unchanged');
});

test('a relink turns the old link off with its receipt, so a repository keeps one active board [E12]', { timeout: 120_000 }, async (t) => { // budget: hang ceiling for real relay calls; not a speed target.
  const box = await teamBoard(t, null);
  const old = JSON.parse(box.readLink()).board;
  const alice = await personSession(box, 'alice');
  const next = randomBytes(16).toString('hex');
  await assert.rejects(box.auth.linkBoard(alice, next, 'fixture/repository'), { code: 'BOARD_REPO_LINKED' }, 'a second board without replaces is refused');
  await assert.rejects(box.auth.linkBoard(alice, next, 'fixture/repository', Infinity, 'e'.repeat(32)), { code: 'BOARD_REPLACE' }, 'replaces must name the active board');
  const linked = await box.auth.linkBoard(alice, next, 'fixture/repository', Infinity, old);
  assert.equal(linked.replaced, old, 'the link reports the board it turned off');
  const receipt = box.auth.boardOff(old);
  assert.equal(receipt?.replacedBy, next, 'the old link is off, with a receipt naming its replacement');
  assert.equal(box.auth.boardOff(next), null, 'the new link is the active one');
  await assert.rejects(box.auth.linkBoard(alice, randomBytes(16).toString('hex'), 'fixture/repository', Infinity, old), { code: 'BOARD_REPLACE' },
    'an off board cannot be replaced again, so no caller can stack links');
  await assert.rejects(box.auth.linkBoard(alice, randomBytes(16).toString('hex'), 'fixture/repository'), { code: 'BOARD_REPO_LINKED' },
    'the replacement is the one active board');
});
