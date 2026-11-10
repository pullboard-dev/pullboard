/** Runner custody observes live job descendants and reaps them only at the command boundary [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDescendantTracker } from '../../index.js';

/** A scripted POSIX identity is stable across parent reparenting, without signalling any real process. */
function row(pid, ppid, pgid) {
  return { pid, ppid, pgid, started: 'Sat Oct 24 09:00:00 2026', state: 'S', command: 'node' };
}

test("a job's detached child lives until the job ends, then custody reaps it [C7]", async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-custody-phase-'));
  const self = 9_100_001, command = 9_100_010, detached = 9_100_020;
  let rows = new Map([[self, row(self, 1, self)]]), phase = 'command running';
  const signals = [];
  const tracker = createDescendantTracker(directory, {
    selfPid: self, census: () => new Map(rows), intervalMs: 3_600_000,
    kill(pid, signal) {
      signals.push({ pid, signal, phase });
      rows = new Map([...rows].filter(([id, value]) => pid < 0 ? value.pgid !== -pid : id !== pid));
    },
  });
  t.after(() => { tracker.stopMonitoring(); rmSync(directory, { recursive: true, force: true }); });
  rows.set(command, row(command, self, command));
  tracker.registerRoot(command);
  tracker.observe();
  rows.set(detached, row(detached, command, detached));
  tracker.observe();
  rows.set(detached, row(detached, 1, detached));
  for (let tick = 0; tick < 16; tick += 1) tracker.observe();
  assert.ok(tracker.cleanupState().live.some(identity => identity.pid === detached), 'custody retains the proven detached identity after reparenting');
  assert.deepEqual(signals, [], 'periodic observation must not signal a child while its job command lives');
  phase = 'command exited';
  rows.delete(command);
  await tracker.stopDescendants();
  await tracker.verifyAfterGroups();
  assert.deepEqual(signals, [{ pid: -detached, signal: 'SIGTERM', phase: 'command exited' }]);
  assert.equal(rows.has(detached), false, 'the owned detached process is reaped at job end');
});
