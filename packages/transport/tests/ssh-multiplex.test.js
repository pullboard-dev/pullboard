/** Runner ssh calls share one multiplexed connection per runner, so a burst of sessions opens one TCP connection [C7]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../test/fixture-child.js';
import { spawnSsh } from '../index.js';
import { sshControlPath } from '../index.js';

const files = privateFixtureFiles('pullboard-ssh-multiplex-');
after(() => rmSync(files.root, { recursive: true, force: true }));
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// A stand-in ssh: `-O check` answers from the control file, a ControlMaster=yes call is one TCP connection that
// creates the control file, and a session logs `mux` when it rides an existing master or `tcp` when it dials itself.
const FAKE_SSH = `#!/bin/sh
cp=; op=; master=; prev=
for a in "$@"; do
  case "$a" in ControlPath=*) cp=\${a#ControlPath=};; ControlMaster=yes) master=1;; esac
  [ "$prev" = "-O" ] && op=$a
  prev=$a
done
if [ "$op" = check ]; then [ -n "$cp" ] && [ -e "$cp" ]; exit $?; fi
if [ -n "$master" ]; then echo tcp >> "$FAKE_SSH_LOG"; : > "$cp"; exit 0; fi
if [ -n "$cp" ] && [ -e "$cp" ]; then echo mux >> "$FAKE_SSH_LOG"; else echo tcp >> "$FAKE_SSH_LOG"; fi
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift 2
exec /bin/sh -c "$*"
`;

/** A private machine home with the stand-in ssh first on PATH; returns the spawn env and the connection log. */
function fakeMachine(name) {
  files.write(`${name}/bin/ssh`, FAKE_SSH);
  chmodSync(join(files.root, name, 'bin', 'ssh'), 0o755);
  files.write(`${name}/home/.keep`, '');
  const log = join(files.root, name, 'connections.log');
  files.write(`${name}/connections.log`, '');
  return { home: join(files.root, name, 'home'), log,
    env: { PATH: `${join(files.root, name, 'bin')}:/usr/bin:/bin`, FAKE_SSH_LOG: log, LC_ALL: 'C' } };
}

/** Run one ssh call through the helper and resolve its exit status and stdout. */
function call(machine, host, command) {
  const child = spawnSsh(['-T', '-o', 'BatchMode=yes', '--', host, command], { env: machine.env, stdio: ['ignore', 'pipe', 'pipe'] },
    { home: machine.home });
  let out = '';
  child.stdout.on('data', bytes => { out += bytes; });
  child.stderr.resume();
  return new Promise(resolve => child.once('close', status => resolve({ status, out })));
}

test('clause 1: 30 concurrent sessions to one runner open one TCP connection; the rest ride its master', async () => {
  const machine = fakeMachine('burst');
  const results = await Promise.all(Array.from({ length: 30 }, (_, index) => call(machine, 'runner@one.test', `echo ok-${index}`)));
  assert.deepEqual(results.map(result => result.status), Array(30).fill(0));
  assert.deepEqual(results.map(result => result.out.trim()), Array.from({ length: 30 }, (_, index) => `ok-${index}`));
  const lines = readFileSync(machine.log, 'utf8').trim().split('\n');
  assert.equal(lines.filter(line => line === 'tcp').length, 1, lines.join(','));
  assert.equal(lines.filter(line => line === 'mux').length, 30);
});

test('clause 1: each runner gets its own control path under the machine home', async () => {
  const machine = fakeMachine('paths');
  const one = sshControlPath('runner@one.test', { home: machine.home });
  const two = sshControlPath('runner@two.test', { home: machine.home });
  assert.ok(one.startsWith(join(machine.home, 'ssh') + '/'));
  assert.notEqual(one, two);
  assert.equal(sshControlPath('runner@one.test', { home: machine.home }), one);
  await Promise.all([call(machine, 'runner@one.test', 'true'), call(machine, 'runner@two.test', 'true')]);
  assert.equal(readFileSync(machine.log, 'utf8').trim().split('\n').filter(line => line === 'tcp').length, 2);
  assert.deepEqual(readdirSync(join(machine.home, 'ssh')).sort(), [one, two].map(path => path.slice(path.lastIndexOf('/') + 1)).sort());
});

test('clause 1: every ssh spawn in the transport and runners cells goes through spawnSsh', () => {
  const found = [];
  for (const cell of ['packages/transport/src', 'packages/runners/src']) {
    for (const entry of readdirSync(join(REPO, cell), { recursive: true })) {
      if (!entry.endsWith('.js')) continue;
      const source = readFileSync(join(REPO, cell, entry), 'utf8');
      if (/spawn(?:Sync)?\(\s*'ssh'/u.test(source)) found.push(`${cell}/${entry}`);
    }
  }
  assert.deepEqual(found, ['packages/transport/src/shell/ssh.js']);
  const helper = readFileSync(join(REPO, 'packages/transport/src/shell/ssh.js'), 'utf8');
  assert.equal(helper.match(/spawn(?:Sync)?\(\s*'ssh'/gu).length, 1, 'only spawnSsh\'s own fallback spawns ssh directly');
});
