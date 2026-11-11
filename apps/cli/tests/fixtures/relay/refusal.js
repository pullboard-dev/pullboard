/** A real recorded add and an unrecorded add need different relay-lock guidance [C6,N26,H16]. */
import assert from 'node:assert/strict';
import { relayClientFixture } from './client.js';

/** Hold only this private project's send lock at the exact post-record boundary, then prove both outcomes. */
export async function recordedRelayRefusal(t) {
  const box = await relayClientFixture(t);
  box.legacySnapshotApi('bad-route');
  box.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'fixture pauses initial checkpoint' });
  const linked = await box.link();
  assert.equal(linked.code, 0, linked.failure);
  const result = await box.script(`
    const { main } = await import(${JSON.stringify(box.mainURL)});
    const { relaySenderIo } = await import(${JSON.stringify(new URL('../../../src/io/sender.js', import.meta.url).href)});
    const { relayOperation } = await import(${JSON.stringify(new URL('../../../../../packages/link/index.js', import.meta.url).href)});
    const { spawn } = await import('node:child_process');
    const { mkdirSync, writeFileSync, rmSync, readFileSync } = await import('node:fs');
    const { DatabaseSync } = await import('node:sqlite');
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const lock = ${JSON.stringify(box.linkFile + '.lock')};
    const database = ${JSON.stringify(box.root + '/.git/pullboard/board.sqlite')};
    const title = 'Recorded before private send lock';
    const missing = 'Unrecorded behind private send lock';
    let owns = false;
    /** A live owned child models another sender; no operational project is touched. */
    function hold() {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(lock + '/pid', String(holder.pid));
      owns = true;
    }
    /** Release only the lock this fixture made, never a successor's directory. */
    function release() {
      if (owns && readFileSync(lock + '/pid', 'utf8') === String(holder.pid)) rmSync(lock, { recursive: true });
      owns = false;
    }
    const outcomes = [];
    try {
      for (const [text, recorded] of [[title, true], [missing, false]]) {
        if (!recorded) hold();
        let stdout = '', stderr = '';
        const streams = {
          cwd: process.cwd(), relayLockWaitMs: 150, relayLockProgressMs: 1000,
          stdout: { write(value) { stdout += value; if (recorded && /^#[0-9]+\\n$/u.test(value)) hold(); } },
          stderr: { write(value) { stderr += value; } }
        };
        let code;
        if (recorded) code = await main(['add', ${JSON.stringify(box.lane)}, text], streams);
        else {
          try {
            await relayOperation(process.cwd(), 'addItem', [{ by: 'coordinator', lane: ${JSON.stringify(box.lane)}, title: text }],
              await relaySenderIo(process.cwd(), { ...streams, err(value) { stderr += value; } }));
            code = 0;
          } catch (error) { code = 1; stderr += error.message; }
        }
        const db = new DatabaseSync(database, { readOnly: true });
        try {
          const rows = db.prepare('SELECT item_id FROM item WHERE item_title=?').all(text);
          const link = JSON.parse(readFileSync(${JSON.stringify(box.linkFile)}, 'utf8'));
          const pending = db.prepare('SELECT COUNT(*) AS count FROM event WHERE event_id>?').get(link.cursor ?? 0).count;
          outcomes.push({ code, stdout, stderr, rows: rows.length, pending, held: owns });
        } finally { db.close(); }
        release();
      }
    } finally {
      release();
      holder.kill('SIGTERM');
      await new Promise(resolve => holder.once('close', resolve));
    }
    console.log(JSON.stringify({ outcomes }));
  `);
  assert.equal(result.code, 0, result.failure);
  const [recorded, missing] = result.document.outcomes;
  assert.equal(recorded.held, true, 'the private lock was acquired only after the real CLI reported its recorded add');
  assert.equal(recorded.rows, 1, 'exactly one item is durable; no retry is needed');
  assert.ok(recorded.pending > 0, 'the paused initial checkpoint leaves real local events waiting for sync');
  assert.match(recorded.stderr, /recorded[\s\S]*queued/iu);
  assert.doesNotMatch(recorded.stderr, /run (?:the |this )?command again|retry (?:the |this )?(?:command|move)/iu);
  assert.equal(missing.held, true);
  assert.equal(missing.rows, 0, 'the blocked operation has not added an item');
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /not (?:been )?recorded/iu);
}
