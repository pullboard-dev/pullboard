/** Machine-wide gate capacity settings through the actual CLI [O5,O6]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Run settings in an isolated machine home, returning its structured CLI result. */
function settings(home, ...args) {
  return spawnSync(process.execPath, [BIN, 'settings', ...args, '--json'], {
    encoding: 'utf8', env: { ...process.env, PULLBOARD_HOME: home },
  });
}

test('[O5,O6] gateSlots defaults to two, reads and sets atomically, and refuses invalid saved values', () => {
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

    writeFileSync(join(home, 'settings.json'), JSON.stringify({ gateSlots: 0 }));
    const refused = settings(home);
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stdout).error.code, 'BAD_GATE_SLOTS');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
