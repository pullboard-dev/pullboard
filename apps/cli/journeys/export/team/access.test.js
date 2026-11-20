/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  assert,
  existsSync,
  filesUnder,
  finishKeylessInbox,
  mkdirSync,
  prepareKeylessInbox,
  readKeylessInbox,
  readdirSync,
  renameSync,
  sessionChild,
  sessionGit,
  sessionRelay,
  statSyncMode,
  symlinkSync,
  test,
  writeFileSync,
} from '../../../tests/fixtures/scenarios/team.js';
import {
  readFileSync,
  copyFileSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';

test('cli.journeys-export-team-access.every-session-reads-and-moves-terminal: every session reads and moves: terminal, SSH, agent, job or CI [E9,E18]', { timeout: 240_000 }, async (t) => { // budget: hang ceiling for real CLI runs on three homes and a loopback relay; not a speed target.
  const box = await sessionRelay(t);
  const cli = join(import.meta.dirname, '../../../pullboard.js');

  // S6d: on a machine with a keychain, relay on keeps the key in the owner-only file every session can read.
  const keychainBin = join(box.root, '..', 'keychain-bin');
  mkdirSync(keychainBin, { mode: 0o700 });
  for (const name of readdirSync(box.env.PATH)) symlinkSync(join(box.env.PATH, name), join(keychainBin, name));
  const keychainLog = join(box.root, '..', 'keychain-calls.log');
  for (const name of ['security', 'secret-tool']) {
    writeFileSync(join(keychainBin, name), `#!/bin/sh\necho "$1" >> ${JSON.stringify(keychainLog)}\n[ "$1" = search ] && exit 1\nexit 0\n`, { mode: 0o755 });
  }
  const plainPath = box.env.PATH;
  const inbox = await prepareKeylessInbox(box);
  box.env.PATH = keychainBin;
  assert.equal((await box.link()).code, 0, 'relay on links the board on a machine with a keychain');
  box.env.PATH = plainPath;
  const keys = join(box.env.PULLBOARD_HOME, 'relay-keys');
  assert.deepEqual(readdirSync(keys).filter((name) => name.endsWith('.key')).length, 1, 'the key sits in one owner-only file');
  assert.equal(statSyncMode(box.keyFile), 0o600, 'the key file is owner-only');
  const writes = existsSync(keychainLog) ? readFileSync(keychainLog, 'utf8').split('\n').filter((call) => ['add-generic-password', 'store'].includes(call)) : [];
  assert.deepEqual(writes, [], 'relay on never writes the key to the keychain');

  // Reads resolve the actual committed policy before the keyless and CI sessions start.
  sessionGit(['add', '-A'], { cwd: box.root, env: box.env });
  sessionGit(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'chore: set up pullboard'], { cwd: box.root, env: box.env });

  // S6b: a session that cannot read the key (SSH, a scheduled job, a locked keychain) still reads the whole board.
  assert.equal((await box.cliLocal('add', box.lane, 'Read from any session')).code, 0);
  renameSync(keys, keys + '.parked');
  try {
    for (const command of [['list'], ['show', '1'], ['inbox'], ['whoami'], ['status'], ['resume'], ['log']]) {
      const read = command[0] === 'inbox' ? await readKeylessInbox(box, inbox) : await box.cliLocal(...command);
      assert.equal(read.code, 0, `${command[0]} reads without the key: ${JSON.stringify(read.document?.error ?? null)}`);
    }
    const move = await box.cliLocal('add', box.lane, 'Needs the key');
    assert.equal(move.document?.error?.code, 'RELAY_KEY_MISSING', 'a move without the key is refused, never sent or lost');
  } finally { renameSync(keys + '.parked', keys); }
  await finishKeylessInbox(box, inbox);

  // S6c: a CI or cloud session, with an agent token and the board key in its environment and no key file, reads and moves.
  // The project's committed setup is what every checkout, CI's included, gets.
  const seatRoot = join(box.root, '..', 'ci-seat');
  sessionGit(['worktree', 'add', '-q', '-b', 'ci-seat', seatRoot], { cwd: box.root, env: box.env });
  const joined = await box.cliAtLocal(seatRoot, 'join', box.lane, '--model', 'fixture-model');
  assert.equal(joined.code, 0, `the person gives CI its own seat: ${JSON.stringify(joined.document?.error ?? null)}`);
  const seat = (await box.cliAtLocal(seatRoot, 'whoami')).document;
  assert.equal((await box.cliAtLocal(seatRoot, 'shout', 'all', 'the CI seat is ready')).code, 0, 'the seat moves once, which mints its token');
  const link = JSON.parse(box.readLink());
  const token = link.agentTokens?.[seat.id]?.token;
  assert.match(token ?? '', /^pa_/u, 'the seat holds its own agent token');
  const ciRoot = join(box.root, '..', 'ci-clone');
  sessionGit(['clone', '-q', box.root, ciRoot], { cwd: box.root, env: box.env });
  sessionGit(['remote', 'set-url', 'origin', 'git@github.com:fixture/repository.git'], { cwd: ciRoot, env: box.env });
  const ciHome = join(box.root, '..', 'ci-home');
  mkdirSync(ciHome, { mode: 0o700 });
  const key = box.readKey().trim();
  // The CI machine also has a keychain holding a legacy copy of the key; the session must not move it into a file.
  const ciKeychainBin = join(ciHome, 'keychain-bin');
  mkdirSync(ciKeychainBin, { mode: 0o700 });
  // Keep these two private tools inside the all-file audit, without following links outside its origin.
  assert.deepEqual(readdirSync(box.env.PATH).sort(), ['git', 'node'], 'the CI tool source is exactly the two native executables');
  copyFileSync(join(box.env.PATH, 'git'), join(ciKeychainBin, 'git'));
  chmodSync(join(ciKeychainBin, 'git'), 0o700);
  copyFileSync(join(box.env.PATH, 'node'), join(ciKeychainBin, 'node'));
  chmodSync(join(ciKeychainBin, 'node'), 0o700);
  for (const name of ['security', 'secret-tool']) {
    writeFileSync(join(ciKeychainBin, name), '#!/bin/sh\ncase "$1" in search) exit 1;; find-generic-password|lookup) printf %s "$PULLBOARD_RELAY_KEY"; exit 0;; esac\nexit 0\n', { mode: 0o755 });
  }
  const ciEnv = { ...box.env, HOME: ciHome, PULLBOARD_HOME: join(ciHome, '.pullboard'), PULLBOARD_MACHINE_HOME: join(ciHome, 'machine'), PATH: ciKeychainBin,
    PULLBOARD_RELAY_TOKEN: token, PULLBOARD_RELAY_KEY: key, PULLBOARD_RELAY_URL: box.origin };
  // Process-level: a separate CI machine with its own PATH, home and token must be a real child.
  const ci = (...args) => sessionChild(ciRoot, ciEnv, [cli, ...args, '--json']);
  const status = await ci('status');
  assert.equal(status.code, 0, 'CI reads the board');
  const listed = await ci('list', '--all');
  assert.ok(listed.document.items.some((item) => (item.title ?? item.item_title) === 'Read from any session'),
    `CI reads the board’s items: ${JSON.stringify(listed.document.items?.map((item) => item.title ?? item.item_title))} ${JSON.stringify(status.document).replaceAll(token, '<token>').replaceAll(key, '<key>').slice(0, 900)}`);
  const added = await ci('add', box.lane, 'Added from CI');
  assert.equal(added.code, 0, `CI moves on the board: ${JSON.stringify(added.document?.error ?? null)}`);
  assert.equal((await box.cliLocal('status')).code, 0);
  const items = (await box.cliLocal('export')).document.tables.item;
  assert.ok(items.some((item) => item.item_title === 'Added from CI'), 'the CI move reaches the person’s board');
  assert.equal(filesUnder(join(ciEnv.PULLBOARD_HOME, 'relay-keys')).length, 0, 'CI keeps no key file');
  const written = [...box.privateTreeBytes(join(ciRoot, '.git', 'pullboard')), ...box.privateTreeBytes(ciHome)].map(bytes => bytes.toString('latin1'));
  assert.equal(written.some((text) => text.includes(token) || text.includes(key)), false, 'neither the token nor the key is written to disk');
  for (const output of [status, listed, added]) {
    const shown = JSON.stringify(output.document) + (output.failure ?? '');
    assert.equal(shown.includes(token) || shown.includes(key), false, 'no output repeats a secret');
  }
  // A clone already linked to another board keeps its link: the environment never overwrites it.
  const otherLink = join(ciRoot, '.git', 'pullboard', 'relay.json');
  const elsewhere = JSON.stringify({ ...JSON.parse(readFileSync(otherLink, 'utf8')), board: 'f'.repeat(32) });
  writeFileSync(otherLink, elsewhere, { mode: 0o600 });
  const warned = await ci('status');
  assert.match(JSON.stringify(warned.document?.diagnostics ?? []), /RELAY_LINKED/u, 'the environment names the link to another board and the read goes on');
  const relayRead = await ci('relay', 'status');
  assert.equal(relayRead.code, 0, `relay status is a read too, so it goes on: ${JSON.stringify(relayRead.document?.error?.code ?? null)}`);
  assert.match(JSON.stringify(relayRead.document?.diagnostics ?? []), /RELAY_LINKED/u, 'relay status names the link to another board');
  const refused = await ci('add', box.lane, 'Added across boards');
  assert.notEqual(refused.code, 0, 'a session on another board’s link does not move');
  for (const output of [warned, relayRead, refused]) {
    const shown = JSON.stringify(output.document) + (output.failure ?? '');
    assert.equal(shown.includes(token) || shown.includes(key), false, 'the refusal repeats no secret');
  }
  assert.equal(readFileSync(otherLink, 'utf8'), elsewhere, 'the other board’s link is left as it was');
});
