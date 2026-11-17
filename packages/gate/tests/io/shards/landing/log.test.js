/** A scheduled wake keeps its stdout and stderr in worker.log, so a crashed landing's reason survives [C7,#2913]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { watch } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { scheduleMainAudit } from '../../../../src/io/main/audit/scheduler.js';
import { wakeLogFile } from '../../../../src/io/main/audit/scheduler.js';

/** Resolve once the file holds the needle, woken by directory change events rather than a timer. */
function eventually(directory, file, needle) {
  return new Promise(resolve => {
    const read = () => existsSync(file) ? readFileSync(file, 'utf8') : '';
    const watcher = watch(directory, () => { if (read().includes(needle)) { watcher.close(); resolve(read()); } });
    if (read().includes(needle)) { watcher.close(); resolve(read()); }
  });
}

test('gate.io-shards-landing-log.the-wake-writes-its-stdout-and: the wake writes its stdout and a crash on stderr to worker.log in its directory [C7,#2913]', { timeout: 20_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pb-wake-log-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worker = join(root, 'wake.mjs');
  writeFileSync(worker, "console.log('wake started');\nthrow new Error('LAND_WORKER: the landing worker stopped without a completed batch');\n");
  await scheduleMainAudit(root, root, new Date(Date.now() + 60_000).toISOString(), pathToFileURL(worker));
  const log = await eventually(root, wakeLogFile(root), 'LAND_WORKER');
  assert.match(log, /wake started/u, 'stdout is kept');
  assert.match(log, /LAND_WORKER: the landing worker stopped without a completed batch/u, 'the crash reason on stderr is kept');
});
