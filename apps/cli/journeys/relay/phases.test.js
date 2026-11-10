/** @pullboard-test-input source-tree */
/** Real private waits prove the phase attached to the existing child stall, not the historical cause [A7,H16,C7]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { locked } from '../../../../packages/link/index.js';
import { relayFixtureChild } from '../../tests/fixtures/relay/client.js';

/** Use only the canonical runner's private temporary home and one phase file per control. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-stall-phase-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, PULLBOARD_COMMAND_PHASE_FILE: join(root, 'phase.jsonl') };
  delete env.PULLBOARD_RELAY_TOKEN;
  delete env.PULLBOARD_RELAY_KEY;
  return { root, env };
}

/** Require a real existing 25-second watchdog failure to retain the actual active phase and timing. */
async function assertStallPhase(t, box, script, phase) {
  await assert.rejects(relayFixtureChild(box.root, box.env, ['--input-type=module', '-e', script], undefined, 0), error => {
    const marker = '\nstall phase capture: ';
    const position = error.message.lastIndexOf(marker);
    assert.ok(position !== -1, 'the unchanged child stall must include its phase capture');
    const capture = JSON.parse(error.message.slice(position + marker.length));
    assert.equal(capture.phase, phase, 'the error names the operation actually blocked in the child');
    assert.ok(Number.isSafeInteger(capture.pid) && capture.pid > 0);
    assert.ok(Number.isFinite(capture.elapsedMs) && capture.elapsedMs > 0, 'real elapsed phase time is retained');
    assert.ok(Array.isArray(capture.timings));
    t.diagnostic('forced stall phase capture: ' + JSON.stringify(capture));
    return true;
  });
}

test('a real relay request held past the child deadline names relay waiting [A7,H16,C7]', async t => {
  const box = fixture(t);
  const server = createServer(() => {}); // Positive control: accept HTTP and deliberately never answer.
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const module = new URL('../../../../packages/link/src/io/relay.js', import.meta.url).href;
  const origin = 'http://127.0.0.1:' + server.address().port;
  // Budget: only this forcing control's HTTP bound is 60s; the unchanged zero-upload child deadline is 25s.
  const script = `import { request } from ${JSON.stringify(module)};
await request({url:${JSON.stringify(origin)}}, '/held', {}, {relayTimeoutMs:60000});`;
  await assertStallPhase(t, box, script, 'waiting-relay');
});

test('a real live relay lock held past the child deadline names lock waiting [A7,H16,C7]', async t => {
  const box = fixture(t);
  const file = join(box.root, 'relay.json');
  let ready;
  let release;
  const acquired = new Promise(resolve => { ready = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const holder = locked(file, async () => { ready(); await released; });
  await acquired;
  const module = new URL('../../../../packages/link/src/io/relay/lock.js', import.meta.url).href;
  try {
    await assertStallPhase(t, box, `import { locked } from ${JSON.stringify(module)};
await locked(${JSON.stringify(file)}, async () => {});`, 'waiting-lock');
  } finally { release(); await holder; }
});

test('a real SQLite export blocked by a private writer names local export work [A7,H16,C7]', async t => {
  const box = fixture(t);
  const file = join(box.root, 'private.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE kept(value TEXT); INSERT INTO kept VALUES (\'retained\'); BEGIN EXCLUSIVE;');
  const module = new URL('../../../../packages/store/index.js', import.meta.url).href;
  // Budget: private SQLite waits 60s so the unchanged 25s child watchdog captures the actual blocked export.
  const script = `import { DatabaseSync } from 'node:sqlite';
import { exportBoard } from ${JSON.stringify(module)};
import { beginCommandPhase } from ${JSON.stringify(new URL('../../../../packages/link/src/io/command.js', import.meta.url).href)};
const db = new DatabaseSync(${JSON.stringify(file)});
db.exec('PRAGMA busy_timeout=60000');
exportBoard({db}, { beginCommandPhase });`;
  try { await assertStallPhase(t, box, script, 'local-export'); }
  finally { db.exec('ROLLBACK'); db.close(); }
});
