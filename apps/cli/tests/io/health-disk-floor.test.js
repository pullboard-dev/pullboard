/** With health.diskFloorGb set, pullboard health warns when free disk drops below it, and never otherwise [C7,#9110]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { before } from 'node:test';
import { test } from 'node:test';
import { diskFloorFinding } from '../../src/io/health/disk.js';
import { settingsInventory } from '../../../../packages/config/index.js';
import { createE2eHelpers } from '../fixtures/e2e.js';

const GB = 2 ** 30;
const e2e = createE2eHelpers();
after(e2e.cleanup);

let box = null;
before(() => { box = e2e.project(); });

/** Set health.diskFloorGb in the fixture machine's settings file; null removes it. */
function setFloor(gb) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  if (gb === null) delete settings.health; else settings.health = { ...settings.health, diskFloorGb: gb };
  writeFileSync(file, JSON.stringify(settings));
}

/** A statfs standing in for a volume with `freeGb` free. */
const volume = freeGb => () => ({ bavail: freeGb * 1024, bsize: GB / 1024 });

test('cli.io-health-disk-floor.a-floor-above-the-free-disk-of: clause 1: a floor above the free disk of the board host prints a warning naming the free space and the floor [C7,#9110]', async () => {
  const finding = diskFloorFinding('/board', 200, volume(42.5));
  assert.match(finding.line, /42\.5 GB free/u);
  assert.match(finding.line, /200 GB floor/u);
  setFloor(1e9);
  const run = await box.runLocal(box.repo, 'health');
  assert.match(run.out, /low disk: [\d.]+ GB free on this board host, under the 1000000000 GB floor/u);
  assert.equal(run.code, 0, 'a warning never changes the exit code');
});

test('cli.io-health-disk-floor.free-disk-above-the-floor-prints-no: clause 2: free disk above the floor prints no warning, and a floor of 0, the default, prints none at all [C7,#9110]', async () => {
  assert.equal(diskFloorFinding('/board', 200, volume(500)), null);
  assert.equal(diskFloorFinding('/board', 200, volume(200)), null, 'free space equal to the floor is not under it');
  assert.equal(diskFloorFinding('/board', 0, volume(0)), null, 'a floor of 0 is off even on a full disk');
  assert.equal(diskFloorFinding('/board', 200, () => { throw new Error('unreadable'); }), null, 'an unreadable volume warns of nothing');
  setFloor(null);
  const run = await box.runLocal(box.repo, 'health');
  assert.doesNotMatch(run.out, /low disk/u);
});

test('cli.io-health-disk-floor.health-diskfloorgb-is-a-described-setting-0: clause 3: health.diskFloorGb is a described setting, 0 by default [C7,#9110]', () => {
  setFloor(null);
  const row = settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'health.diskFloorGb');
  assert.equal(row.default, 0);
  assert.equal(row.value, 0);
  assert.ok(row.label && /free space/u.test(row.description ?? JSON.stringify(row)), 'the row carries a plain label and description');
});
