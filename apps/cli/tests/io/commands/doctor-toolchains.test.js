/** @pullboard-test-input source-cell apps/cli */
/** pullboard doctor names a detected language whose toolchain no registered runner declares, and a managed repo with no git maintenance [C7,#10782]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpFixture } from '../../fixtures/api.js';
import { fixtureMachineSettings } from '../../fixtures/testkit.js';
import { runCliInProcess } from '../../fixtures/process.js';

/** A fixture project holding a Go module, with these runners in its machine settings. */
function goProject(t, runners) {
  const box = apiHttpFixture(t);
  writeFileSync(join(box.root, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { runners });
  return box;
}

/** The doctor output for the box. */
async function doctor(box) {
  const ran = await runCliInProcess(['doctor'], { cwd: box.root, env: box.env });
  return ran.stdout + ran.stderr;
}

test('cli.io-commands-doctor-toolchains.doctor-with-go-mod-and-runners-that: clause 1: doctor with go.mod and runners that declare only node names go missing on every runner and the runner add step [C7]', async t => {
  const box = goProject(t, [{ host: 'a.local', slots: 1, browser: 0, toolchains: { node: '22' } }]);
  const out = await doctor(box);
  const lines = out.split('\n').filter(line => /toolchain go is missing on every runner/u.test(line));
  assert.equal(lines.length, 1, out);
  assert.match(lines[0], /pullboard runner add <ssh-host> --toolchain go=/u);
});

test('cli.io-commands-doctor-toolchains.a-runner-that-declares-go-clears-the: clause 2: a runner that declares go clears the toolchain line [C7]', async t => {
  const box = goProject(t, [{ host: 'a.local', slots: 1, browser: 0, toolchains: { node: '22' } }, { host: 'b.local', slots: 1, browser: 0, toolchains: { go: '1.22' } }]);
  assert.doesNotMatch(await doctor(box), /toolchain go is missing/u);
});

test('cli.io-commands-doctor-toolchains.a-repo-with-no-runners-prints-no: clause 3: a repo with no runners prints no toolchain line [C7]', async t => {
  const box = goProject(t, []);
  assert.doesNotMatch(await doctor(box), /toolchain .* is missing/u);
});

test('cli.io-commands-doctor-toolchains.doctor-reports-unregistered-git-maintenance: clause 3: doctor reports a managed repo with git maintenance not registered, and registering it clears the line [C7,#10782]', async t => {
  const box = apiHttpFixture(t);
  const global = join(dirname(box.root), 'global.gitconfig');
  writeFileSync(global, '');
  box.env.GIT_CONFIG_GLOBAL = global;
  const lines = out => out.split('\n').filter(line => /git maintenance is not registered/u.test(line));
  const before = lines(await doctor(box));
  assert.equal(before.length, 1, before.join('\n'));
  assert.ok(before[0].includes(box.root), before[0]);
  assert.match(before[0], /repair: run git -C ".+" config maintenance\.prefetch\.enabled false, then git -C ".+" maintenance start/u);
  const registered = spawnSync('git', ['maintenance', 'register'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(registered.status, 0, registered.stderr);
  assert.deepEqual(lines(await doctor(box)), []);
});
