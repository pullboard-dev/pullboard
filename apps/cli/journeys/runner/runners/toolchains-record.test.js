/** runner add records a runner's toolchains in the machine settings and keeps them on re-registration [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseToolchains } from '../../../../../packages/config/index.js';
import { registrationGuiFixture } from '../../../tests/fixtures/runner/gui.js';
import { HOST } from '../../../tests/fixtures/runner/ssh.js';
import { cli } from '../../../tests/fixtures/runner/tooling.js';

/** The registered runner row as the machine settings file holds it. */
const stored = box => JSON.parse(readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8')).runners.find(runner => runner.host === HOST);

test('clause 1: runner add --toolchain records the toolchains and registering the host again keeps them [C7]', t => {
  const box = registrationGuiFixture(t);
  const first = cli(box.repo, box.env, 'runner', 'add', HOST, '--slots', '1', '--browser', '0', '--toolchain', 'node=22,python=3.12,go=1.23,cargo', '--json');
  assert.equal(first.status, 0, first.context);
  assert.deepEqual(stored(box).toolchains, { node: '22', python: '3.12', go: '1.23', cargo: '' });
  const again = cli(box.repo, box.env, 'runner', 'add', HOST, '--slots', '1', '--browser', '0', '--json');
  assert.equal(again.status, 0, again.context);
  assert.deepEqual(stored(box).toolchains, { node: '22', python: '3.12', go: '1.23', cargo: '' });
});

test('clause 1: a malformed toolchain list is refused with the form to use [C7]', () => {
  assert.deepEqual(parseToolchains('node=22,cargo'), { node: '22', cargo: '' });
  for (const bad of ['', 'Node=22', 'node=22,node=20', 'go=1 2', 'a'.repeat(40)]) {
    assert.throws(() => parseToolchains(bad), error => error.code === 'BAD_RUNNER', bad);
  }
});
