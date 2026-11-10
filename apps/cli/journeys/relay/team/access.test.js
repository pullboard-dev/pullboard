/** Account changes cannot retain a different person's cached agent authority [H2,H9]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  delimiter,
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
// The native child executes this entry point; keep its affected-test dependency explicit.
import '../../../index.js';
import {
  ACCESS_WINDOW_MS,
  createRelayAuth,
} from '../../../../relay/index.js';
import { createAuthHandler } from '../../../../relay/index.js';
import { createRelayHandler } from '../../../../relay/index.js';
import { createRelayJournal } from '../../../../relay/index.js';
import {
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from '../../../../../packages/kernel/index.js';
import {
  runFixtureChild,
  runFixtureChildAsync,
} from '../../../tests/fixtures/child.js';

const CLI = resolve(import.meta.dirname, '../../../pullboard.js');

/** Read only private link metadata; callers never include credential values in diagnostics. */
function linkState(root) {
  return JSON.parse(readFileSync(join(root, '.git/pullboard/relay.json'), 'utf8'));
}

/** Exercise the real CLI, auth database, journal and account switch with a two-person provider. */
test("a removed person's agent cannot move on the board [H2,H9]", async (t) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-team-access-')));
  let auth;
  let server;
  let relay;
  let journal;
  t.after(async () => {
    journal?.close();
    relay?.close();
    server?.closeAllConnections();
    if (server?.listening) await new Promise(done => server.close(done));
    auth?.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  const root = join(scratch, 'repo');
  const home = join(scratch, 'home');
  const bin = join(scratch, 'bin');
  for (const path of [root, home, bin]) mkdirSync(path, { mode: 0o700 });
  const gitPath = process.env.PATH.split(delimiter).map(path => join(path, 'git')).find(existsSync);
  assert.ok(gitPath, 'the private fixture has Git');
  symlinkSync(realpathSync(gitPath), join(bin, 'git'));
  symlinkSync(realpathSync(process.execPath), join(bin, 'node'));
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: join(home, '.pullboard'),
    PULLBOARD_MACHINE_HOME: join(scratch, 'machine'), PATH: bin, PULLBOARD_MODEL: 'fixture-model',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Team Fixture', GIT_AUTHOR_EMAIL: 'team@example.test',
    GIT_COMMITTER_NAME: 'Team Fixture', GIT_COMMITTER_EMAIL: 'team@example.test' };
  for (const name of ['PULLBOARD_RELAY_TOKEN', 'PULLBOARD_RELAY_KEY', ...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[name];
  /** Execute real private Git commands without disclosing private child output. */
  function git(...args) {
    assert.equal(runFixtureChild('git', args, { cwd: root, env, encoding: 'utf8' }).status, 0, `private git ${args[0]} succeeds`);
  }
  /** Return the actual JSON CLI refusal without putting private JSON or bearer data into assertions. */
  async function cli(...args) {
    const result = await runFixtureChildAsync(process.execPath, [CLI, ...args, '--json'], { cwd: root, env });
    assert.equal(result.signal, null, 'the private CLI exits normally');
    return { code: result.status, document: JSON.parse(result.stdout) };
  }
  const people = new Map([['alice', { id: '7', login: 'alice', permission: 'write' }],
    ['bob', { id: '8', login: 'bob', permission: 'write' }]]);
  const grants = new Map();
  const permissionChecks = [];
  let signer = 'alice';
  let origin;
  const github = {
    /** Bind each device grant to the person signing in, rather than a mutable global identity. */
    async startDevice() {
      const deviceCode = randomUUID();
      grants.set(deviceCode, signer);
      return { deviceCode, userCode: 'FIXTURE', verificationURL: origin + '/fixture-device', expiresIn: 600, interval: 1 };
    },
    /** Complete only a previously issued private device grant. */
    async pollDevice(deviceCode) { assert.ok(grants.has(deviceCode)); return { accessToken: deviceCode }; },
    /** Resolve the immutable identity attached to the grant. */
    async user(value) { const { id, login } = people.get(grants.get(value)); return { id, login }; },
    /** Model independent current roles for both people; real relay auth decides whether to permit them. */
    async access(user, repository) {
      assert.equal(repository, 'fixture/repository');
      const person = people.get(user.login);
      assert.equal(person.id, user.id);
      permissionChecks.push({ user: user.id, permission: person.permission });
      return { id: '100', name: repository, permission: person.permission, public: false };
    },
  };
  // The auth clock moves past one access window when the test removes a person (#1013).
  let authOffsetMs = 0;
  auth = createRelayAuth({ database: join(scratch, 'auth.sqlite'), github, now: () => Date.now() + authOffsetMs });
  const relayDirectory = join(scratch, 'relay');
  let signIn;
  const acceptedMoves = [];
  server = createServer(async (req, res) => {
    if (req.method === 'POST' && /\/moves$/u.test(req.url)) {
      res.once('finish', () => { if (res.statusCode === 200) acceptedMoves.push(true); });
    }
    if (await signIn(req, res)) return;
    await relay(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  signIn = createAuthHandler({ auth, publicOrigin: origin });
  relay = createRelayHandler({ directory: relayDirectory, auth, publicOrigin: origin, maintenanceMs: 0 });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'private team fixture\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'chore: seed');
  assert.equal((await cli('init')).code, 0);
  git('remote', 'add', 'origin', 'git@github.com:fixture/repository.git');
  const lane = Object.keys(JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')).lanes)[0];
  assert.equal((await cli('relay', 'on', '--url', origin)).code, 0);
  assert.equal((await cli('add', lane, 'Alice before account change')).code, 0);
  const alice = linkState(root);
  assert.ok(alice.agentTokens.coordinator, 'the original account has a real cached agent credential');
  assert.equal((await auth.authenticate(alice.agentTokens.coordinator.token, { board: alice.board, write: true })).user.id, '7');

  signer = 'bob';
  assert.equal((await cli('relay', 'on', '--url', origin)).code, 0, 'the same linked checkout signs in as Bob');
  assert.equal(linkState(root).account, '8', 'the saved machine account actually changes');
  assert.equal((await cli('add', lane, 'Bob before removal')).code, 0);
  const bob = linkState(root);
  const cachedOwner = (await auth.authenticate(bob.agentTokens.coordinator.token, { board: bob.board, write: true })).user.id;
  journal = createRelayJournal({ directory: relayDirectory, boardId: bob.board });
  const prefix = journal.latest();
  const accepted = acceptedMoves.length;
  const checks = permissionChecks.length;
  people.get('bob').permission = 'none';
  // A grant lasts one access window, so the removal takes effect once it ends, never later [H8,H21].
  authOffsetMs = ACCESS_WINDOW_MS;
  const refused = await cli('add', lane, 'Bob after removal');
  assert.equal(refused.document.error?.code, 'NO_REPO_ACCESS', 'the removed person cannot send through a cached agent');
  assert.equal(refused.code, 1, 'the CLI reports the typed refusal');
  assert.equal(acceptedMoves.length, accepted, 'no removed-person move enters the relay');
  assert.equal(journal.latest(), prefix, 'the durable relay prefix does not advance');
  assert.equal(cachedOwner, '8', 'the agent credential belongs to the newly signed-in person');
  assert.ok(permissionChecks.slice(checks).some(check => check.user === '8' && check.permission === 'none'), 'the first write after the window refreshes Bob current access');
  assert.equal(people.get('alice').permission, 'write', 'Alice retains access throughout the revocation');
});
