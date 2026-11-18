/** The config cell resolves the machine settings file the queue cell is handed [O5,O6,C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { machineHome } from '../../../../resources/index.js';
import { machineSettingsFile } from '../../../../resources/index.js';
import { DEFAULT_QUEUE_AGING_MINUTES } from '../../../../queue/index.js';
import { gateQueueSettings } from '../../../index.js';

test('config.logic-settings-door.the-config-cell-resolves-the-machine: [O5,C7] the config cell resolves the machine settings file the queue cell is handed', () => {
  assert.equal(machineSettingsFile(), join(machineHome(), 'settings.json'));
});

test('config.logic-settings-door.the-settings-front-door-still-reads-the: [O5,O6] the settings front door still reads the machine home settings file', () => {
  const files = privateFixtureFiles('pullboard-queue-port-');
  files.write('settings.json', JSON.stringify({ gate: { queue: { reviewsFirst: true, agingMinutes: 12 } } }));
  files.write('empty/.keep', '');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = files.root;
  try {
    assert.equal(machineSettingsFile(), join(files.root, 'settings.json'));
    assert.deepEqual(gateQueueSettings(), { reviewsFirst: true, currentReleaseFirst: false, agingMinutes: 12 });
    process.env.PULLBOARD_MACHINE_HOME = join(files.root, 'empty');
    assert.deepEqual(gateQueueSettings(), { reviewsFirst: false, currentReleaseFirst: false, agingMinutes: DEFAULT_QUEUE_AGING_MINUTES });
  } finally {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(files.root, { recursive: true, force: true });
  }
});
