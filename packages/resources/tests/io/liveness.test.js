/** An older pullboard's time-based reclaimer never signals or frees a live holder in the shared slot database [C7,#3164]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { waitForCondition } from '../../../gate/tests/fixtures/runner/holders.js';
import { PINNED_HEARTBEAT } from '../../src/io/liveness.js';

const REPO = resolve(import.meta.dirname, '../../../..');
const RESOURCES = pathToFileURL(join(REPO, 'packages/resources/index.js')).href;

/** A holder that takes one machine slot, writes its pid, then idles until killed. */
const HOLDER = `(async () => {
  const { takeResource } = await import(${JSON.stringify(RESOURCES)});
  await takeResource({ name: 'stale-cli', capacity: 1, scope: 'machine', agent: 'holder' });
  require('node:fs').writeFileSync(process.argv[2], String(process.pid));
  setInterval(() => {}, 1000);
})();
`;

/**
 * The reclaimer every pullboard before #3154 runs on each slot update: a holder whose heartbeat is past the 120 s hung
 * window is sent SIGTERM and marked terminating, then SIGKILLed after its grace. Reproduced from that code's own rule.
 */
function legacyReclaim(db, now = Date.now()) {
  const signalled = [];
  for (const row of db.prepare('SELECT token, pid, heartbeat, terminating FROM holder').all()) {
    if (!(row.terminating > 0 || row.heartbeat < now - 120_000)) continue;
    signalled.push(row.pid);
    if (row.terminating === 0) {
      try { process.kill(row.pid, 'SIGTERM'); } catch { /* Already gone. */ }
      db.prepare('UPDATE holder SET terminating = ? WHERE token = ?').run(now, row.token);
    } else try { process.kill(row.pid, 'SIGKILL'); } catch { /* Already gone. */ }
  }
  return signalled;
}

test('resources.liveness.a-stale-cli-s-reclaimer-never: clause 2: a stale CLI\'s reclaimer never signals or frees a live holder whose beat is long past its window [C7,#3164]', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-stale-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  writeFileSync(join(dir, 'holder.cjs'), HOLDER);
  const ready = join(dir, 'ready');
  const holder = spawn(process.execPath, [join(dir, 'holder.cjs'), ready], { detached: true, stdio: 'ignore', env: { ...process.env, PULLBOARD_MACHINE_HOME: home } });
  let exited = false;
  holder.on('exit', () => { exited = true; });
  t.after(() => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* Already gone. */ } });
  await waitForCondition(() => existsSync(ready), 'the holder takes the slot');
  const db = new DatabaseSync(join(home, 'resources.sqlite'));
  db.exec('PRAGMA busy_timeout = 2000');
  t.after(() => db.close());
  // The holder is blocked in synchronous work: an older client writes the stale beat it would see.
  const stale = Date.now() - 10 * 60_000;
  db.prepare('UPDATE holder SET heartbeat = ? WHERE pid = ?').run(stale, holder.pid);
  const row = db.prepare('SELECT heartbeat, beat, terminating FROM holder WHERE pid = ?').get(holder.pid);
  assert.equal(row.heartbeat, PINNED_HEARTBEAT, 'older readers see a heartbeat no window can pass');
  assert.equal(row.beat, stale, 'the real beat is kept for current readers');
  for (let round = 0; round < 3; round += 1) assert.deepEqual(legacyReclaim(db), [], 'the stale reclaimer finds nothing to signal');
  // Even an older client that marks the row terminating cannot arm its SIGKILL follow-up.
  db.prepare('UPDATE holder SET terminating = ? WHERE pid = ?').run(Date.now() - 60_000, holder.pid);
  assert.equal(db.prepare('SELECT terminating FROM holder WHERE pid = ?').get(holder.pid).terminating, 0);
  assert.deepEqual(legacyReclaim(db), []);
  // Nothing was signalled above, so the holder answers now, with no wait for a signal that never came.
  assert.doesNotThrow(() => process.kill(holder.pid, 0), 'the live holder was never signalled');
  assert.equal(exited, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM holder WHERE pid = ?').get(holder.pid).n, 1, 'and keeps its slot');
  // A holder an older client inserts directly is pinned the same way.
  db.prepare("INSERT INTO holder(token, name, pid, started, agent, repo, since, heartbeat) VALUES ('old-client', 'stale-cli', ?, '', 'old', '', '', ?)").run(holder.pid, stale);
  assert.deepEqual({ ...db.prepare("SELECT heartbeat, beat FROM holder WHERE token = 'old-client'").get() }, { heartbeat: PINNED_HEARTBEAT, beat: stale });
});
