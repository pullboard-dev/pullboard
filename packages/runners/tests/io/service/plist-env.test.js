/** install-serve puts the serve's job count and run ceiling in the agent plist, so a runner's serve claims as many jobs as its record registers [C7,#11871]. */
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

/** A throwaway HOME, a fake launchctl that only exits 0, and an install root; no real launchctl runs. */
function fixture(t) {
  const base = privateFixtureFiles('pb11871-').root;
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = join(base, 'bin'), home = join(base, 'home');
  mkdirSync(bin); mkdirSync(home);
  writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'launchctl'), 0o755);
  return { base, bin, home, root: join(base, 'root') };
}

/** Run the installer in this process with the fixture's PATH and HOME for the given plan and return the plist text it wrote. */
async function installedPlist({ bin, home, root }, extra) {
  const plan = { label: SERVICE_LABEL, root, remove: false, board: 'http://127.0.0.1:1/api/v1/boards/b', key: 'k', entry: 'svc.cjs', files: { 'svc.cjs': '// stand-in\n' }, ...extra };
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME }, stdin = Object.getOwnPropertyDescriptor(process, 'stdin'), write = process.stdout.write;
  let out = '';
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, HOME: home });
  Object.defineProperty(process, 'stdin', { value: Readable.from([Buffer.from(JSON.stringify(plan))]), configurable: true });
  // The test runner's own events share this stream, so only the installer's reply line is taken and everything else goes on to the real stream.
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === 'string' && chunk.startsWith('{"installed"')) { out += chunk; return true; } return write.call(process.stdout, chunk, ...rest); };
  try { await runnerServiceInstaller(); } finally { Object.assign(process.env, saved); Object.defineProperty(process, 'stdin', stdin); process.stdout.write = write; }
  return readFileSync(JSON.parse(out.trim()).plist, 'utf8');
}

test('runners.io-service-plist-env.installer-writes-jobs-and-ceiling: clause 1: given a plan with jobs 10 and ceilingMs 2400000, the installer writes a LaunchAgent plist whose EnvironmentVariables holds PULLBOARD_RUNNER_JOBS 10 and PULLBOARD_RUNNER_RUN_CEILING_MS 2400000 [C7,#11871]', async t => {
  const plist = await installedPlist(fixture(t), { jobs: 10, ceilingMs: 2_400_000 });
  assert.match(plist, /<key>EnvironmentVariables<\/key>\s*<dict>[^]*<key>PULLBOARD_RUNNER_JOBS<\/key><string>10<\/string>[^]*<\/dict>/u);
  assert.match(plist, /<key>PULLBOARD_RUNNER_RUN_CEILING_MS<\/key><string>2400000<\/string>/u);
  assert.match(plist, /<key>PATH<\/key>/u, 'PATH and HOME stay beside the new keys');
});

test('runners.io-service-plist-env.install-sends-slots-and-default-ceiling: clause 2: installRunnerService over a fake ssh and a registered runner with slots 7 sends a plan carrying jobs 7 and the default ceilingMs 2400000 [C7,#11871]', async t => {
  const paths = fixture(t), planFile = join(paths.base, 'plan.json'), ssh = join(paths.bin, 'ssh');
  writeFileSync(ssh, `#!/bin/sh\ncat > '${planFile}'\nprintf '%s\\n' '{"installed":true,"form":"agent","loaded":true,"sudo":null}'\n`);
  chmodSync(ssh, 0o755);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(paths.base, 'machine-home');
  try {
    const reply = await installRunnerService({ host: 'mini-7', slots: 7 }, { board: 'http://127.0.0.1:1/api/v1/boards/b', key: 'k', ssh, env: { ...process.env, PULLBOARD_MACHINE_HOME: process.env.PULLBOARD_MACHINE_HOME } });
    assert.equal(reply.installed, true);
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  assert.equal(plan.jobs, 7);
  assert.equal(plan.ceilingMs, 2_400_000);
});

test('runners.io-service-plist-env.session-env: clause 1: the plist written for form agent carries PULLBOARD_RUNNER_SESSION=gui in its EnvironmentVariables and the plist for form daemon carries PULLBOARD_RUNNER_SESSION=daemon, beside PULLBOARD_RUNNER_JOBS [C7,P7]', async t => {
  const agent = await installedPlist(fixture(t), { form: 'agent', jobs: 4 });
  assert.match(agent, /<key>EnvironmentVariables<\/key>\s*<dict>[^]*<key>PULLBOARD_RUNNER_SESSION<\/key><string>gui<\/string>[^]*<\/dict>/u);
  assert.match(agent, /<key>PULLBOARD_RUNNER_JOBS<\/key><string>4<\/string>/u);
  const daemon = await installedPlist(fixture(t), { form: 'daemon', jobs: 4 });
  assert.match(daemon, /<key>EnvironmentVariables<\/key>\s*<dict>[^]*<key>PULLBOARD_RUNNER_SESSION<\/key><string>daemon<\/string>[^]*<\/dict>/u);
  assert.match(daemon, /<key>PULLBOARD_RUNNER_JOBS<\/key><string>4<\/string>/u);
});
