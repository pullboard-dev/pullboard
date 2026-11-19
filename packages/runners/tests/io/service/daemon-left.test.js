/** install-serve never loads a LaunchAgent while an older system LaunchDaemon for the label remains, and records the pending removal [P7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { installRunnerService } from '../../../src/io/service.js';
import { runnerServiceInstaller } from '../../../src/io/service.js';
import { SERVICE_LABEL } from '../../../src/io/service.js';
import { STAND_IN_SERVE } from '../../fixtures/stand-in-serve.js';

const BOARD = 'http://127.0.0.1:1/api/v1/boards/b';

/** A throwaway HOME, a fake launchctl that logs each call, and a daemons folder that may hold the old plist. */
function fixture(t, { daemon }) {
  const base = privateFixtureFiles('pb11864-').root;
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = join(base, 'bin'), home = join(base, 'home'), daemons = join(base, 'daemons'), calls = join(base, 'launchctl.log');
  mkdirSync(bin); mkdirSync(home); mkdirSync(daemons);
  writeFileSync(join(bin, 'launchctl'), `#!/bin/sh\necho "$@" >> '${calls}'\nexit 0\n`);
  chmodSync(join(bin, 'launchctl'), 0o755);
  if (daemon) writeFileSync(join(daemons, `${SERVICE_LABEL}.plist`), '<plist/>');
  return { base, bin, home, daemons, calls, root: join(base, 'root') };
}

/** Run the agent-form installer in this process, as the current user, and return its JSON reply. */
async function install({ bin, home, root, daemons }) {
  const plan = { label: SERVICE_LABEL, root, daemons, remove: false, form: 'agent', board: BOARD, key: 'k', entry: 'svc.cjs', files: { 'svc.cjs': STAND_IN_SERVE } };
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME }, stdin = Object.getOwnPropertyDescriptor(process, 'stdin'), write = process.stdout.write;
  let out = '';
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, HOME: home });
  Object.defineProperty(process, 'stdin', { value: Readable.from([Buffer.from(JSON.stringify(plan))]), configurable: true });
  process.stdout.write = chunk => { out += String(chunk); return true; };
  try { await runnerServiceInstaller(); } finally { Object.assign(process.env, saved); Object.defineProperty(process, 'stdin', stdin); process.stdout.write = write; }
  // The test reporter may write to stdout while it is captured, so take only the installer's own reply line.
  return JSON.parse(/\{"installed":.*\}/u.exec(out)[0]);
}

/** The launchctl calls the fake logged, one per line, or none. */
function calls(paths) {
  try { return readFileSync(paths.calls, 'utf8').trim().split('\n'); } catch { return []; }
}

test('runners.daemon-left.agent-not-loaded-beside-old-daemon: clause 1: the install program run as a non-root user with the daemon plist present does not bootstrap the agent and reports pendingRemoval true with the exact sudo line [P7]', { skip: process.getuid() === 0 }, async t => {
  const paths = fixture(t, { daemon: true });
  const reply = await install(paths);
  assert.equal(reply.pendingRemoval, true);
  assert.equal(reply.loaded, false);
  assert.equal(reply.sudo, `sudo sh -c "launchctl bootout system/${SERVICE_LABEL} 2>/dev/null; rm -f '${join(paths.daemons, `${SERVICE_LABEL}.plist`)}'"`);
  assert.ok(!calls(paths).some(line => line.startsWith('bootstrap')), `no bootstrap was issued: ${calls(paths).join(' | ')}`);
  assert.ok(readFileSync(reply.plist, 'utf8').includes(SERVICE_LABEL), 'the agent plist is still written');
});

test('runners.daemon-left.agent-loaded-without-old-daemon: clause 2: with no daemon plist the install loads the agent as before and reports pendingRemoval false [P7]', { skip: process.getuid() === 0 }, async t => {
  const paths = fixture(t, { daemon: false });
  const reply = await install(paths);
  assert.equal(reply.pendingRemoval, false);
  assert.equal(reply.loaded, true);
  assert.equal(reply.sudo, null);
  assert.ok(calls(paths).some(line => line.startsWith('bootstrap')), 'the agent was bootstrapped');
});

test('runners.daemon-left.record-keeps-pending-removal: clause 3: installRunnerService records pendingRemoval and the sudo line in the runner-services record when the reply says so [P7]', async t => {
  const base = privateFixtureFiles('pb11864-record-').root;
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sudo = 'sudo sh -c "launchctl bootout system/x; rm -f /Library/LaunchDaemons/x.plist"';
  const ssh = join(base, 'fake-ssh');
  writeFileSync(ssh, `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '${JSON.stringify({ installed: true, form: 'agent', loaded: false, pendingRemoval: true, sudo })}'\n`);
  chmodSync(ssh, 0o755);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(base, 'machine');
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const reply = await installRunnerService({ host: 'mini-1' }, { board: BOARD, key: 'k', ssh, env: { ...process.env, PATH: process.env.PATH } });
  assert.equal(reply.pendingRemoval, true);
  const record = JSON.parse(readFileSync(join(base, 'machine', 'runner-services.json'), 'utf8'))['mini-1'];
  assert.equal(record.pendingRemoval, true);
  assert.equal(record.sudo, sudo);
  assert.equal(record.loaded, false);
});
