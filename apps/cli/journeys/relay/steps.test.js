/** A relay refusal's next step is a command the person can run, and running it resolves the refusal [C7,H17]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
} from 'node:fs';
import {
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
function pullboardOnPath(files) {
  files.write('bin/pullboard', `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(join(files.root, 'bin/pullboard'), 0o755);
  return join(files.root, 'bin');
}

test('IMPORT_NOT_EMPTY on relay join names a command the person runs, and running it joins [C7,H17]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const code = (await box.cli('relay', 'pair')).document.code;
  const files = privateFixtureFiles('pullboard-join-step-');
  const scratch = files.root;
  const bin = pullboardOnPath(files);
  const bare = join(scratch, 'project.git');
  const home = join(scratch, 'home');
  mkdirSync(home, { mode: 0o700 });
  const env = { ...box.env, HOME: home, PULLBOARD_HOME: join(home, '.pullboard'), PULLBOARD_MACHINE_HOME: join(scratch, 'machine'),
    PATH: [bin, box.env.PATH, '/usr/bin', '/bin'].join(':'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`, GIT_CONFIG_VALUE_0: 'git@github.com:fixture/repository.git' };
  const sh = (cwd, command, extra = {}) => spawnSync('sh', ['-c', command], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  assert.equal(sh(scratch, `git clone --bare "${box.root}" project.git`).status, 0);
  assert.equal(sh(scratch, `git clone "${bare}" first && git -C first remote set-url origin git@github.com:fixture/repository.git`).status, 0);
  // A shell that declares a model gives the new board a seat, so the clone's board is not empty.
  const first = join(scratch, 'first');
  assert.equal(sh(first, 'pullboard init', { PULLBOARD_MODEL: FIXTURE_MODEL }).status, 0);
  const refused = sh(first, `pullboard relay join ${code} --url ${box.origin} --json`, { PULLBOARD_MODEL: FIXTURE_MODEL });
  assert.notEqual(refused.status, 0, 'a clone whose board holds work is refused');
  const { error } = JSON.parse(refused.stdout);
  assert.equal(error.code, 'IMPORT_NOT_EMPTY');
  assert.ok(error.next.startsWith(PERSON_RUNS), 'the step is a command for the person');
  assert.doesNotMatch(error.next, /coordinator/u, 'the person is not sent to the coordinator for a person-only command');
  assert.equal(refusalDocument(Object.assign(new Error(error.message), { code: error.code, next: error.next }), { caller: 'person' }).error.next, error.next,
    'the person-facing refusal keeps the command');
  const followed = sh(scratch, error.next.slice(PERSON_RUNS.length).replace('pullboard-join', join(scratch, 'second')).replace(' && cd ' + join(scratch, 'second'), ' && cd ' + join(scratch, 'second')));
  assert.equal(followed.status, 0, `following the step joins: ${followed.stderr}`);
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
  const token = typeof other === 'string' ? other : other.token;
  const wrong = spawnSync(process.execPath, [CLI, 'shout', 'all', 'sent with the wrong token', '--json'], { cwd: box.root, env: { ...box.env, PULLBOARD_RELAY_TOKEN: token }, encoding: 'utf8' });
  const { error } = JSON.parse(wrong.stdout);
  assert.equal(error.code, 'RELAY_ACTOR', error.message);
  assert.equal(error.next, 'run unset PULLBOARD_RELAY_TOKEN in this shell, then run the command again');
  const rerun = await box.cliLocal('shout', 'all', 'sent with the wrong token');
  assert.equal(rerun.code, 0, 'without the token the move is sent');
});
