/** A relay refusal's next step is a command the person can run, and running it resolves the refusal [C7,H17]. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import {
  delimiter,
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { refusalDocument } from '../../index.js';
import {
  FIXTURE_MODEL,
  privateFixtureFiles,
} from '../../tests/fixtures/child.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

const CLI = resolve(import.meta.dirname, '../../pullboard.js');
const PERSON_RUNS = 'in your own terminal, run: ';

/** A `pullboard` on the PATH that runs this checkout's CLI, so a printed step runs word for word. */
function pullboardOnPath(files, bare, path) {
  // The fixture's origin is a GitHub address that only a clone may reach, so only `git clone` is pointed at the local bare copy.
  const git = path.split(delimiter).map(entry => join(entry, 'git')).find(existsSync);
  files.write('bin/git', `#!/bin/sh\nif [ "$1" = clone ]; then export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="url.${bare}.insteadOf" GIT_CONFIG_VALUE_0=git@github.com:fixture/repository.git; fi\nexec "${git}" "$@"\n`);
  chmodSync(join(files.root, 'bin/git'), 0o755);
  files.write('bin/pullboard', `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(join(files.root, 'bin/pullboard'), 0o755);
  return join(files.root, 'bin');
}

test('IMPORT_NOT_EMPTY on relay join names a command the person runs, and running it joins [C7,H17]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const code = (await box.cliLocal('relay', 'pair')).document.code;
  const files = privateFixtureFiles('pullboard-join-step-');
  const scratch = files.root;
  const bare = join(scratch, 'project.git');
  const bin = pullboardOnPath(files, bare, box.env.PATH);
  const home = join(scratch, 'home');
  mkdirSync(home, { mode: 0o700 });
  const env = { ...box.env, HOME: home, PULLBOARD_HOME: join(home, '.pullboard'), PULLBOARD_MACHINE_HOME: join(scratch, 'machine'),
    PATH: [bin, box.env.PATH, '/usr/bin', '/bin'].join(':') };
  // Asynchronous: the fixture relay answers from this process, so a blocking spawn would starve it and the join would time out.
  const sh = (cwd, command, extra = {}) => new Promise(done => {
    execFile('sh', ['-c', command], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 },
      (failure, stdout, stderr) => done({ status: failure ? (typeof failure.code === 'number' ? failure.code : 1) : 0, stdout, stderr }));
  });
  assert.equal((await sh(scratch, `git clone --bare "${box.root}" project.git`)).status, 0);
  assert.equal((await sh(scratch, `git clone "${bare}" first && git -C first remote set-url origin git@github.com:fixture/repository.git`)).status, 0);
  // A shell that declares a model gives the new board a seat, so the clone's board is not empty.
  const first = join(scratch, 'first');
  assert.equal((await sh(first, 'pullboard init', { PULLBOARD_MODEL: FIXTURE_MODEL })).status, 0);
  const refused = await sh(first, `pullboard relay join ${code} --url ${box.origin} --json`, { PULLBOARD_MODEL: FIXTURE_MODEL });
  assert.notEqual(refused.status, 0, 'a clone whose board holds work is refused');
  const { error } = JSON.parse(refused.stdout);
  assert.equal(error.code, 'IMPORT_NOT_EMPTY');
  assert.ok(error.next.startsWith(PERSON_RUNS), 'the step is a command for the person');
  assert.doesNotMatch(error.next, /coordinator/u, 'the person is not sent to the coordinator for a person-only command');
  assert.equal(refusalDocument(Object.assign(new Error(error.message), { code: error.code, next: error.next }), { caller: 'person' }).error.next, error.next,
    'the person-facing refusal keeps the command');
  const followed = await sh(scratch, error.next.slice(PERSON_RUNS.length) + ' --json');
  assert.equal(followed.status, 0, `following the step joins: ${error.next} ${followed.stdout} ${followed.stderr} ${JSON.stringify(box.calls.slice(-6).map(call => call.method + ' ' + call.path))}`);
});

test('ACCOUNT_STORAGE_LIMIT names relay off in an unneeded project, and running it leaves the board working [C7,H17]', async t => {
  const box = await relayClientFixture(t, { accountStorageBytes: 1000 });
  const linked = await box.link();
  const line = (linked.document.diagnostics ?? []).find(text => text.includes('ACCOUNT_STORAGE_LIMIT'));
  assert.ok(line, 'the full account is named');
  assert.doesNotMatch(line, /relay on again/u, 'running relay on again changes nothing, so it is not the step');
  const step = /; (free space: run (pullboard relay off) in a project[^;]*)$/u.exec(line);
  assert.ok(step, 'the step names relay off and where to approve it: ' + line);
  const [, , command] = step;
  const off = await box.cliLocal(...command.split(' ').slice(1));
  assert.equal(off.code, 0, 'relay off runs where the person runs it');
  assert.match(off.document.notice, /phone/u, 'it says the deletion is approved on the phone');
  assert.equal((await box.cliLocal('status')).document.relay.linked, false, 'the paused upload no longer holds this board');
  assert.equal((await box.cliLocal('shout', 'all', 'local work carries on')).code, 0, 'the board keeps working locally');
});

test('RELAY_ACTOR names unset PULLBOARD_RELAY_TOKEN for another agent\'s token, and running it sends the move [C7,H17]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const link = JSON.parse(box.readLink());
  const other = await box.auth.issueToken(link.token, { board: link.board, agent: 'someone-else' });
  const result = await box.script(`
    const { actorTransport } = await import(${JSON.stringify(new URL('../../../../packages/link/src/io/relay/seats.js', import.meta.url).href)});
    const { readFileSync } = await import('node:fs');
    const file = ${JSON.stringify(box.linkFile)};
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const io = {};
    process.env.PULLBOARD_RELAY_TOKEN = ${JSON.stringify(typeof other === 'string' ? other : other.token)};
    let refusal;
    try { await actorTransport(process.cwd(), file, state, 'coordinator', io); } catch (error) { refusal = { code: error.code, next: error.next }; }
    delete process.env.PULLBOARD_RELAY_TOKEN; // The step: run unset PULLBOARD_RELAY_TOKEN in this shell.
    const sent = await actorTransport(process.cwd(), file, state, 'coordinator', io);
    console.log(JSON.stringify({ refusal, agent: sent.agent }));
  `);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.document.refusal?.code, 'RELAY_ACTOR', 'another agent\'s token is refused');
  assert.equal(result.document.refusal.next, 'run unset PULLBOARD_RELAY_TOKEN in this shell, then run the command again');
  assert.equal(result.document.agent, 'coordinator', 'after the step the move is sent by its own agent');
});
