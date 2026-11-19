/** @pullboard-test-input source-cell apps/cli */
/** runner add --toolchain auto records the toolchains the runner's probe discovers [C7,#10376]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpFixture } from '../../fixtures/api.js';
import { runCliInProcess } from '../../fixtures/process.js';
import { installRegistrationProbeStandIn } from '../../fixtures/runner/ssh.js';

/** A fixture whose only commands on PATH are node, the registration ssh stand-in and these fake toolchains (name to the version line it prints). */
function runnerBox(t, toolchains) {
  const box = apiHttpFixture(t);
  const bin = join(box.root, '..', 'discover-bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  installRegistrationProbeStandIn({ bin });
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const [name, line] of Object.entries(toolchains)) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho '${line}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { box, env: { ...box.env, PATH: bin } };
}

/** Register a runner with these flags and return the command result and the toolchains settings.json holds for it. */
async function add({ box, env }, ...flags) {
  const argv = ['runner', 'add', 'discover-fixture.invalid', '--slots', '1', '--browser', '0', '--node', process.execPath, ...flags];
  const ran = await runCliInProcess(argv, { cwd: box.root, env });
  const settings = JSON.parse(readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8'));
  return { ran, toolchains: settings.runners?.[0]?.toolchains, output: ran.stdout + ran.stderr };
}

test('cli.io-commands-runner-discover.runner-add-toolchain-auto-with-a-probe: clause 1: runner add --toolchain auto with a probe that answers python3 and swift records exactly those two toolchains [C7,#10376]', async t => {
  const { ran, toolchains, output } = await add(runnerBox(t, { python3: 'Python 3.12.1', swift: 'Swift version 6.0.2' }), '--toolchain', 'auto');
  assert.equal(ran.status, 0, output);
  assert.deepEqual(toolchains, { python3: '3.12.1', swift: '6.0.2' });
});

test('cli.io-commands-runner-discover.a-declared-toolchain-list-records-the-declared: clause 2: a declared --toolchain list records the declared versions the runner verifies, exactly as without auto [C7,#10376]', async t => {
  const { ran, toolchains, output } = await add(runnerBox(t, { python3: 'Python 3.12.1', swift: 'Swift version 6.0.2' }), '--toolchain', 'python3=3.12');
  assert.equal(ran.status, 0, output);
  assert.deepEqual(toolchains, { python3: '3.12' });
});

test('cli.io-commands-runner-discover.toolchain-auto-with-nothing-answering-records-no: clause 3: --toolchain auto with nothing answering records no toolchains and says so [C7,#10376]', async t => {
  const { ran, toolchains, output } = await add(runnerBox(t, {}), '--toolchain', 'auto');
  assert.equal(ran.status, 0, output);
  assert.equal(toolchains, undefined);
  assert.match(output, /found no toolchain; none recorded/u);
});

/** Make the registration ssh stand-in wait this long before it answers, as a loaded runner or a slow link would. */
function delaySsh(bin, ms) {
  const real = join(bin, 'ssh-answers');
  renameSync(join(bin, 'ssh'), real);
  writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env node\nconst { spawnSync } = require('node:child_process');\nsetTimeout(() => { const ran = spawnSync(${JSON.stringify(real)}, process.argv.slice(2), { stdio: 'inherit' }); process.exitCode = ran.status ?? 255; }, ${ms});\n`);
  chmodSync(join(bin, 'ssh'), 0o755);
}

test('cli.io-commands-runner-discover.registration-probe-answering-after-four-seconds-registers: clause 1: runner add with an ssh stand-in that waits 4 seconds before it answers registers the runner and exits 0 [C7]', async t => {
  const box = runnerBox(t, {});
  delaySsh(join(box.box.root, '..', 'discover-bin'), 4000);
  const { ran, output } = await add(box);
  assert.equal(ran.status, 0, output);
  assert.match(output, /registered runner discover-fixture\.invalid/u);
});
