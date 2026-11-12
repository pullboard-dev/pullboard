/** install-serve writes a full system PATH and reloads the service with bootout then bootstrap, never kickstart alone [6070]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runnerServiceInstaller } from '../../../src/io/service.js';
import { SERVICE_LABEL } from '../../../src/io/service.js';

/** Run the installer in this process against a fake launchctl that logs its arguments and a throwaway HOME; no real launchctl runs. */
async function install(t) {
  const base = privateFixtureFiles('pb6070-').root;
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = join(base, 'bin'), home = join(base, 'home'), log = join(base, 'launchctl.log');
  mkdirSync(bin); mkdirSync(home);
  writeFileSync(join(bin, 'launchctl'), `#!/bin/sh\necho "$@" >> '${log}'\nexit 0\n`);
  chmodSync(join(bin, 'launchctl'), 0o755);
  const plan = { label: SERVICE_LABEL, root: join(base, 'root'), remove: false, board: 'http://127.0.0.1:1/api/v1/boards/b', key: 'k', entry: 'svc.js', files: { 'svc.js': '' } };
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME }, stdin = Object.getOwnPropertyDescriptor(process, 'stdin'), write = process.stdout.write;
  t.after(() => { Object.assign(process.env, saved); Object.defineProperty(process, 'stdin', stdin); process.stdout.write = write; });
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, HOME: home });
  Object.defineProperty(process, 'stdin', { value: Readable.from([JSON.stringify(plan)]), configurable: true });
  process.stdout.write = () => true;
  await runnerServiceInstaller();
  const plist = readFileSync(join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`), 'utf8');
  return { plist, calls: readFileSync(log, 'utf8').trim().split('\n') };
}

test('6070 clause 1: the generated plist PATH holds /usr/bin, /bin, /usr/sbin and /sbin so ps and lsof resolve [P7]', async t => {
  const { plist } = await install(t);
  const path = plist.match(/<key>PATH<\/key><string>([^<]*)<\/string>/u)?.[1].split(':');
  for (const directory of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) assert.ok(path.includes(directory), `${directory} in ${path}`);
});

test('6070 clause 3: the service is booted out, then bootstrapped, and kickstart is never issued [P7]', async t => {
  const { calls } = await install(t);
  const verbs = calls.map(call => call.split(' ')[0]);
  assert.ok(verbs.includes('bootout') && verbs.includes('bootstrap'));
  assert.ok(verbs.indexOf('bootout') < verbs.indexOf('bootstrap'));
  assert.ok(!verbs.includes('kickstart'), calls.join('\n'));
  assert.match(calls.find(call => call.startsWith('bootstrap')), /LaunchAgents\/dev\.pullboard\.runner-serve\.plist$/u);
});
