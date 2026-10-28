/** The queue cell reads machine settings only from the file its caller names [O5,O6,C7]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { machineHome, machineSettingsFile } from '../src/machine-home.js';
import { DEFAULT_QUEUE_AGING_MINUTES, readGateQueueSettings, readMachineSettingsFile } from '../src/queue-settings.js';
import { gateQueueSettings } from '../src/settings.js';

const QUEUE_SETTINGS = resolve(import.meta.dirname, '../src/queue-settings.js');

/** Write one settings object into a fresh directory, returning the directory and its file. */
function settingsDir(value) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-queue-port-'));
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify(value));
  return { dir, file };
}

test('[O5,C7] queue-settings imports nothing above the queue cell: the settings file is a caller-supplied port', () => {
  const source = readFileSync(QUEUE_SETTINGS, 'utf8');
  assert.doesNotMatch(source, /from '\.\/machine-home\.js'/u);
  assert.equal(machineSettingsFile(), join(machineHome(), 'settings.json'));
});

test('[O5,O6] readGateQueueSettings reads the named file, not the machine home', () => {
  const { dir, file } = settingsDir({ gate: { queue: { reviewsFirst: true, currentReleaseFirst: true, agingMinutes: 7 } } });
  try {
    assert.deepEqual(readGateQueueSettings(file), { reviewsFirst: true, currentReleaseFirst: true, agingMinutes: 7 });
    assert.equal(readMachineSettingsFile(file).gate.queue.agingMinutes, 7);
    assert.deepEqual(readGateQueueSettings(join(dir, 'absent.json')), { reviewsFirst: false, currentReleaseFirst: false, agingMinutes: DEFAULT_QUEUE_AGING_MINUTES });
    assert.equal(readMachineSettingsFile(join(dir, 'absent.json')), null);
    writeFileSync(file, JSON.stringify({ gate: { queue: { agingMinutes: 0 } } }));
    assert.throws(() => readGateQueueSettings(file), error => error.code === 'BAD_MACHINE_SETTINGS' && error.message.includes(file));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('[O5,O6] the settings front door still reads the machine home settings file', () => {
  const { dir } = settingsDir({ gate: { queue: { reviewsFirst: true, agingMinutes: 12 } } });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = dir;
  try {
    assert.equal(machineSettingsFile(), join(dir, 'settings.json'));
    assert.deepEqual(gateQueueSettings(), { reviewsFirst: true, currentReleaseFirst: false, agingMinutes: 12 });
    mkdirSync(join(dir, 'empty'));
    process.env.PULLBOARD_MACHINE_HOME = join(dir, 'empty');
    assert.deepEqual(gateQueueSettings(), { reviewsFirst: false, currentReleaseFirst: false, agingMinutes: DEFAULT_QUEUE_AGING_MINUTES });
  } finally {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
