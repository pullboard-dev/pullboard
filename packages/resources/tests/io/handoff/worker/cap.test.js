/** The hand-off ticket queue keeps submit order on a durable counter and refuses when it is damaged [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  handoffQueueDirectory,
  reserveHandoffTicket,
} from '../../../../index.js';

/** Count launch tickets while retaining the queue's durable counter and other bookkeeping. */
function tickets() { return readdirSync(handoffQueueDirectory()).filter(name => /^\d+-.+\.(json|reserved)$/u.test(name)); }

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

test('a damaged durable ticket counter refuses instead of reordering the queue [C7]', async () => {
  const cleanup = privateHome();
  try {
    mkdirSync(handoffQueueDirectory(), { recursive: true });
    writeFileSync(join(handoffQueueDirectory(), 'next-ticket'), 'damaged');
    await assert.rejects(reserveHandoffTicket('next-job'), { code: 'HANDOFF_TICKET_SOURCE' });
    assert.equal(readFileSync(join(handoffQueueDirectory(), 'next-ticket'), 'utf8'), 'damaged');
    assert.deepEqual(tickets(), []);
  } finally { cleanup(); }
});
