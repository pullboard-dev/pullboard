/** The runner probe verifies each recorded toolchain: runner add keeps only the verified ones, and a later probe names any now missing or the wrong version [C7]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
import { HOST } from '../../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../tests/fixtures/runner/ssh.js';
import { toolchainVerdict } from '../../../../../packages/runners/src/io/probe.js';

const DIRS = [];
after(() => { for (const dir of DIRS) rmSync(dir, { recursive: true, force: true }); });

/** A private machine home, a stand-in ssh that runs probes locally, and fake toolchain commands on its PATH. */
function box() {
  const dir = privateFixtureFiles('pullboard-toolchains-').root;
  DIRS.push(dir);
  const bin = join(dir, 'bin'), worker = join(dir, 'worker'), home = join(dir, 'worker-home');
  const machineHome = join(dir, 'machine-home'), remoteMachineHome = join(home, '.pullboard');
  for (const folder of [bin, worker, home, remoteMachineHome, machineHome]) mkdirSync(folder, { recursive: true });
  installSshStandIn({ bin, worker, home, machineHome: remoteMachineHome, requests: join(dir, 'ssh-requests.jsonl') });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PULLBOARD_HOME: join(dir, 'pullboard-home'), PULLBOARD_MACHINE_HOME: machineHome };
  /** Put a fake toolchain command on the runner's PATH that prints one version line. */
  const tool = (name, line) => { writeFileSync(join(bin, name), `#!/bin/sh\necho ${JSON.stringify(line)}\n`); chmodSync(join(bin, name), 0o755); };
  const cli = (...args) => runCliInProcess(args, { cwd: dir, env });
  return { dir, bin, tool, cli };
}

test('cli.journeys-runner-toolchains-probe.the-probe-names-every-recorded: clause 1: the probe names every recorded toolchain that is missing or the wrong version [C7]', () => {
  const declared = { node: '', pyfake: '3.12', gofake: '1.23', cargofake: '' };
  const verdict = toolchainVerdict(declared, { node: '22.13.1', pyfake: '3.12.4', gofake: '1.22.5', cargofake: null });
  assert.deepEqual(verdict.verified, { node: '', pyfake: '3.12' }, 'an empty version accepts any, and 3.12 accepts 3.12.4');
  assert.deepEqual(verdict.problems.map(({ name, problem }) => [name, problem]), [['gofake', 'wrong version'], ['cargofake', 'missing']]);
  assert.equal(verdict.problems[0].found, '1.22.5');
  assert.equal(toolchainVerdict({ py: '3' }, { py: '30.1' }).problems.length, 1, 'version 3 does not accept 30.1');
});

test('cli.journeys-runner-toolchains-probe.a-runner-probe-after-a-toolchain-went: clause 1: a runner probe after a toolchain went missing reports it, through the real stand-in ssh [C7]', async () => {
  const b = box();
  b.tool('tcfakeone', 'tcfakeone 3.12.4');
  const added = await b.cli('runner', 'add', HOST, '--slots', '1', '--browser', '0', '--toolchain', 'tcfakeone=3.12', '--json');
  assert.equal(added.status, 0, added.stderr);
  rmSync(join(b.bin, 'tcfakeone'));
  const measured = await b.cli('runner', 'measure', HOST);
  assert.match(measured.stdout, /runner fixture-host: toolchain tcfakeone is missing \(declared 3\.12\)/u, measured.stdout + measured.stderr);
});

test('cli.journeys-runner-toolchains-probe.runner-add-records-only-the-toolchains: clause 2: runner add records only the toolchains the probe verified and names the rest [C7]', async () => {
  const b = box();
  b.tool('tcokay', 'tcokay version 3.12.4');
  b.tool('tcwrong', 'tcwrong 1.22.5');
  const added = await b.cli('runner', 'add', HOST, '--slots', '1', '--browser', '0', '--toolchain', 'tcokay=3.12,tcwrong=1.23,tcmissing', '--json');
  assert.equal(added.status, 0, added.stderr);
  assert.deepEqual(JSON.parse(added.stdout).runner.toolchains, { tcokay: '3.12' }, 'the wrong version and the missing command are not recorded');
  const human = await b.cli('runner', 'add', HOST, '--slots', '1', '--browser', '0', '--toolchain', 'tcokay=3.12,tcwrong=1.23,tcmissing');
  assert.match(human.stdout, /toolchain tcwrong is the wrong version \(declared 1\.23, found 1\.22\.5\)/u, human.stdout);
  assert.match(human.stdout, /toolchain tcmissing is missing \(any version\)/u, human.stdout);
  assert.doesNotMatch(human.stdout, /tcokay is/u);
});
