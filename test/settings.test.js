/** Machine-wide gate capacity settings through the actual CLI [O5,O6]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const MACHINE_HOME_MODULE = resolve(import.meta.dirname, '../src/machine-home.js');

/** Run settings in an isolated machine home, returning its structured CLI result. */
function settings(home, ...args) {
  return spawnSync(process.execPath, [BIN, 'settings', ...args, '--json'], {
    encoding: 'utf8', env: { ...process.env, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: home },
  });
}

test('[O5,O6] gateSlots defaults to two, reads and sets atomically, and refuses invalid values', () => {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-settings-'));
  try {
    const initial = settings(home);
    assert.equal(initial.status, 0, initial.stderr);
    assert.equal(JSON.parse(initial.stdout).settings.gateSlots, 2);

    const changed = settings(home, 'gateSlots', '3');
    assert.equal(changed.status, 0, changed.stderr);
    assert.equal(JSON.parse(changed.stdout).settings.gateSlots, 3);
    assert.equal(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).gateSlots, 3);
    assert.equal(JSON.parse(settings(home).stdout).settings.gateSlots, 3);

    const saved = readFileSync(join(home, 'settings.json'), 'utf8');
    for (const value of ['0', 'abc']) {
      const refusedSet = settings(home, 'gateSlots', value);
      assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), saved, `${value} leaves settings.json unchanged`);
      assert.equal(refusedSet.status, 1, `${value}: ${refusedSet.stdout}${refusedSet.stderr}`);
      assert.equal(JSON.parse(refusedSet.stdout).error.code, 'USAGE');
    }

    writeFileSync(join(home, 'settings.json'), JSON.stringify({ gateSlots: 0 }));
    const refused = settings(home);
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stdout).error.code, 'BAD_GATE_SLOTS');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('[Q4] the machine pool ignores board and HOME overrides unless explicitly selected', () => {
  const script = `import { machineHome } from ${JSON.stringify(MACHINE_HOME_MODULE)}; process.stdout.write(machineHome());`;
  const env = { ...process.env, HOME: '/private/home', PULLBOARD_HOME: '/private/board' };
  delete env.PULLBOARD_MACHINE_HOME;
  const defaultHome = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env });
  assert.equal(defaultHome.status, 0, defaultHome.stderr);
  assert.equal(defaultHome.stdout, join(userInfo().homedir, '.pullboard'));

  const override = join(tmpdir(), 'pullboard-private-machine-home');
  const privateHome = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...env, PULLBOARD_MACHINE_HOME: override },
  });
  assert.equal(privateHome.status, 0, privateHome.stderr);
  assert.equal(privateHome.stdout, resolve(override));
});
