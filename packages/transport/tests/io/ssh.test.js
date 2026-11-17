/** @pullboard-test-input source-cell packages/transport packages/runners */
/** Runner ssh calls share multiplexed masters per runner, opening a new one only when MaxSessions fills a master [C7]. */
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
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { spawnSsh } from '../../index.js';
import { sshControlPath } from '../../index.js';

const files = privateFixtureFiles('pullboard-ssh-multiplex-');
after(() => rmSync(files.root, { recursive: true, force: true }));
const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

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
  chmodSync(join(files.root, name, 'bin/ssh'), 0o755);
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

// Each session holds until all 30 have started, so every one is live at once and the masters' session counts are real.
const BARRIER = 'echo started >> "$FAKE_SSH_LOG.barrier"; while [ "$(wc -l < "$FAKE_SSH_LOG.barrier")" -lt 30 ]; do sleep 0.05; done';

/** The connection log as lines: `tcp` per connection dialled, `mux` per session that rode a master. */
function connections(machine) {
  return readFileSync(machine.log, 'utf8').trim().split('\n').filter(Boolean);
}

test('transport.ssh.xconcurrent-sessions-to-one-runner: clause 1: 30 concurrent sessions to one runner share three masters, a new one only when ten sessions fill a master [C7]', async () => {
  const machine = fakeMachine('burst');
  const results = await Promise.all(Array.from({ length: 30 }, (_, index) => call(machine, 'runner@one.test', `${BARRIER}; echo ok-${index}`)));
  assert.deepEqual(results.map(result => result.status), Array(30).fill(0));
  assert.deepEqual(results.map(result => result.out.trim()), Array.from({ length: 30 }, (_, index) => `ok-${index}`));
  const lines = connections(machine);
  assert.equal(lines.filter(line => line === 'tcp').length, 3, lines.join(','));
  assert.equal(lines.filter(line => line === 'mux').length, 30);
  const base = sshControlPath('runner@one.test', { home: machine.home });
  const masters = readdirSync(join(machine.home, 'ssh')).filter(name => /^[0-9a-f]{12}\.\d+$/u.test(name)).sort();
  assert.deepEqual(masters, [0, 1, 2].map(slot => `${base.slice(base.lastIndexOf('/') + 1)}.${slot}`));
});

test('transport.ssh.sessions-one-after-another-reuse-the: clause 1: sessions one after another reuse the first master instead of opening their own connection [C7]', async () => {
  const machine = fakeMachine('serial');
  for (let index = 0; index < 12; index += 1) assert.equal((await call(machine, 'runner@one.test', 'true')).status, 0);
  const lines = connections(machine);
  assert.deepEqual([lines.filter(line => line === 'tcp').length, lines.filter(line => line === 'mux').length], [1, 12], lines.join(','));
});

test('transport.ssh.each-runner-gets-its-own-control: clause 1: each runner gets its own control path under the machine home [C7]', async () => {
  const machine = fakeMachine('paths');
  const one = sshControlPath('runner@one.test', { home: machine.home });
  const two = sshControlPath('runner@two.test', { home: machine.home });
  assert.ok(one.startsWith(join(machine.home, 'ssh') + '/'));
  assert.notEqual(one, two);
  assert.equal(sshControlPath('runner@one.test', { home: machine.home }), one);
  await Promise.all([call(machine, 'runner@one.test', 'true'), call(machine, 'runner@two.test', 'true')]);
  assert.equal(connections(machine).filter(line => line === 'tcp').length, 2);
  const names = readdirSync(join(machine.home, 'ssh'));
  for (const path of [one, two]) assert.ok(names.includes(`${path.slice(path.lastIndexOf('/') + 1)}.0`), names.join(','));
});

test('transport.ssh.every-ssh-spawn-in-the-transport: clause 1: every ssh spawn in the transport and runners cells goes through spawnSsh [C7]', () => {
  const found = [];
  for (const cell of ['packages/transport/src', 'packages/runners/src']) {
    for (const entry of readdirSync(join(REPO, cell), { recursive: true })) {
      if (!entry.endsWith('.js')) continue;
      const source = readFileSync(join(REPO, cell, entry), 'utf8');
      if (/spawn(?:Sync)?\(\s*'ssh'/u.test(source)) found.push(`${cell}/${entry}`);
    }
  }
  assert.deepEqual(found, ['packages/transport/src/io/ssh.js']);
  const helper = readFileSync(join(REPO, 'packages/transport/src/io/ssh.js'), 'utf8');
  assert.equal(helper.match(/spawn(?:Sync)?\(\s*'ssh'/gu).length, 1, 'only spawnSsh\'s own fallback spawns ssh directly');
});
