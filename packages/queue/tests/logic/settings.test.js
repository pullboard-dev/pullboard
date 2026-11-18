/** The queue cell reads machine settings only from the file its caller names [O5,O6,C7]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_QUEUE_AGING_MINUTES,
  readGateQueueSettings,
  readMachineSettingsFile,
} from '../../index.js';

/** Write one settings object into a fresh directory, returning the directory and its file. */
function settingsDir(value) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-queue-port-'));
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify(value));
  return { dir, file };
}

test('queue.settings.reads-named-file: [O5,O6] readGateQueueSettings reads the named file, not the machine home', () => {
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
