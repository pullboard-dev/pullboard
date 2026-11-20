/** Below the ceiling, and with next.holdAboveLoad off, next hands claims as before; split from load-ceiling.test.js so each file runs under a minute on a loaded runner [C7,#9703]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { machineSettingsFile } from '../../../../../packages/config/index.js';
import { setMachineLoadPort } from '../../../../../packages/resources/index.js';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';

/** Write this fixture machine's settings, keeping the settings the fixture wrote. */
function machineSettings(next, machine = {}) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, next, machine }));
}

/** Inject a 1-minute load on a 4-core machine (ceiling 6) outside any admitted gate run; restore both after the test. */
function injectLoad(t, load) {
  const restore = setMachineLoadPort({ loadavg: () => [load, load, load], cores: () => 4 });
  const saved = process.env.PULLBOARD_GATE_SLOT_HELD;
  delete process.env.PULLBOARD_GATE_SLOT_HELD;
  t.after(() => {
    restore();
    if (saved === undefined) delete process.env.PULLBOARD_GATE_SLOT_HELD; else process.env.PULLBOARD_GATE_SLOT_HELD = saved;
  });
}

test('cli.io-next-load-ceiling-below.cli-next-load-ceiling-below-the-ceiling: cli.next.load-ceiling.below-the-ceiling-next-hands-claims: clause 3: below the ceiling next hands claims as before, and the hold is off by default [C7,#9703]', async t => {
  const box = await fixture(t);
  const open = box.add('Open build');
  machineSettings({ holdAboveLoad: true });
  injectLoad(t, 2);
  const below = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(below.code, 0, below.out + below.err);
  assert.equal(below.document.item.item_id, open, 'below the ceiling the build is handed over');
});

test('cli.io-next-load-ceiling-below.cli-next-load-ceiling-with-next-holdaboveload: cli.next.load-ceiling.with-next-holdaboveload-off-a-load: clause 3: with next.holdAboveLoad off, a load above the ceiling changes nothing [C7,#9703]', async t => {
  const box = await fixture(t);
  const open = box.add('Open build');
  machineSettings({});
  injectLoad(t, 30);
  const off = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(off.code, 0, off.out + off.err);
  assert.equal(off.document.item.item_id, open);
});
