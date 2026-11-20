/** The hand-off ticket queue drops a withdrawn job's place and nothing else [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  dropHandoffTicket,
  handoffQueueDirectory,
  handoffTicketWaiting,
} from '../../../../index.js';

/** A private machine home; the returned function puts the environment back and removes it. */
function privateHome() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-handoff-cap-')));
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'home');
  return () => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  };
}

test('resources.cap.dropping-a-ticket-removes-its-place: dropping a job\'s hand-off ticket removes its place in line and leaves every other job\'s place [C7]', () => {
  const cleanup = privateHome();
  try {
    mkdirSync(handoffQueueDirectory(), { recursive: true });
    for (const name of ['000000000001-job-a.json', '000000000002-job-a.reserved', '000000000003-job-b.json']) writeFileSync(join(handoffQueueDirectory(), name), '{}\n');
    assert.equal(handoffTicketWaiting('job-a'), true);
    assert.equal(dropHandoffTicket('job-a'), 2);
    assert.equal(handoffTicketWaiting('job-a'), false);
    assert.equal(handoffTicketWaiting('job-b'), true);
    assert.deepEqual(readdirSync(handoffQueueDirectory()), ['000000000003-job-b.json']);
  } finally { cleanup(); }
});
