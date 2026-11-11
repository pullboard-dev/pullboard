/** Slow presence journeys split from presence.test.js to stay inside the per-file budget [B3,H16]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { decodeBoardKey } from '../../../../packages/kernel/index.js';
import { unseal } from '../../../../packages/kernel/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { legacyRelayClientFixture } from '../../tests/fixtures/relay/client.js';
import { relayWorkBudgetMs } from '../../tests/fixtures/relay/budget.js';

test('explicit SessionStart observation upgrades an existing resume hook without rewriting it [B3,I6]', async (t) => {
  const { createE2eHelpers } = await import('../../tests/fixtures/e2e.js');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const file = join(box.repo, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  const custom = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo custom; pullboard resume', timeout: 17 }] };
  settings.hooks.SessionStart = [custom];
  writeFileSync(file, JSON.stringify(settings));
  const upgraded = box.run(box.repo, 'init', '--verbose');
  assert.equal(upgraded.code, 0, upgraded.err + upgraded.out);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.hooks.SessionStart.length, 2);
  assert.ok(after.hooks.SessionStart[0].hooks[0].command.includes('hook SessionStart'));
  assert.deepEqual(after.hooks.SessionStart[1], custom, 'the existing user hook bytes remain its own command');
  const again = box.run(box.repo, 'init', '--verbose');
  assert.equal(again.code, 0, again.err + again.out);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), after, 'repeated init never duplicates the observation hook');
});

/** Read or change only the named, disposable fixture SQLite file, closing it before CLI work resumes. */
function fixtureDatabase(file, work) {
  const db = new DatabaseSync(file);
  try { return work(db); }
  finally { db.close(); }
}

/** Count this diagnostic's one requested operation independently from presentation uploads. */
function operationCount(file, text) {
  return fixtureDatabase(file, db => db.prepare('SELECT COUNT(*) AS n FROM shout WHERE shout_text=?').get(text).n);
}

/** Keep diagnostics to checkpoint metadata: no sealed contents, credentials or board body. */
function traceEvidence(result) {
  return { code: result.code, refusalCode: result.document?.error?.code ?? null, uploads: result.snapshotUploads,
    trace: result.snapshotTrace.map(({ sequence, ciphertext, callers, status, abort }) => ({ sequence, ciphertext, callers, status, abort })) };
}

test('a write after a heartbeat uploads once [B3,H16]', {
  timeout: relayWorkBudgetMs(), // budget: unchanged six-attempt relay fixture allowance, not a speed target.
}, async t => {
  const box = await legacyRelayClientFixture(t);
  await box.link();
  const boardFile = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const presenceFile = boardFile + '.presence.sqlite';
  const freshText = 'PUBLISHER_HEARTBEAT_FRESH';
  const staleText = 'PUBLISHER_HEARTBEAT_STALE';
  const fresh = await box.cliWithSnapshotTrace(1, 'shout', box.lane, freshText);
  t.diagnostic('fresh write: ' + JSON.stringify(traceEvidence(fresh)));
  assert.equal(fresh.code, 0);
  const heartbeat = fixtureDatabase(presenceFile, db => db.prepare('SELECT seat,at FROM heartbeat').all());
  assert.equal(heartbeat.length, 1, 'this disposable fixture has only its coordinator heartbeat');
  assert.ok(Date.now() - Date.parse(heartbeat[0].at) < 60_000, 'the first write has a genuinely fresh production heartbeat'); // budget: declared production freshness boundary from seat-presence.js, not a latency target.
  const agedAt = new Date(Date.now() - 120_000).toISOString();
  fixtureDatabase(presenceFile, db => assert.equal(db.prepare('UPDATE heartbeat SET at=? WHERE seat=?').run(agedAt, heartbeat[0].seat).changes, 1)); // budget: derived fixture age is two production refresh intervals; this equality counts SQLite rows, not elapsed time.
  const aged = await box.cliWithSnapshotTrace(1, 'status');
  t.diagnostic('publish aged presentation: ' + JSON.stringify(traceEvidence(aged)));
  assert.equal(aged.code, 0);
  assert.equal(fixtureDatabase(presenceFile, db => db.prepare('SELECT at FROM heartbeat WHERE seat=?').get(heartbeat[0].seat).at), agedAt,
    'the real status read publishes the aged presentation without refreshing its heartbeat');
  const stale = await box.cliWithSnapshotTrace(1, 'shout', box.lane, staleText);
  t.diagnostic('stale write: ' + JSON.stringify(traceEvidence(stale)));
  assert.equal(stale.code, 0);
  const counts = { fresh: operationCount(boardFile, freshText), stale: operationCount(boardFile, staleText) };
  t.diagnostic('requested operation counts: ' + JSON.stringify(counts));
  assert.deepEqual(counts, { fresh: 1, stale: 1 }, 'each real CLI operation is recorded exactly once');
  assert.equal(fresh.snapshotTrace.length, 1, 'fresh presence needs only the ordered checkpoint');
  assert.equal(aged.snapshotTrace.length, 1, 'the changed aged presentation is published once before the second write');
  assert.equal(stale.snapshotTrace.length, 1, 'the ordered checkpoint includes the refreshed presence without another upload');
  // The write publishes through the command's one end-of-command sync, not through a second presence upload.
  assert.ok(stale.snapshotTrace[0].callers.some(caller => caller.includes('retrySync')), 'the sole checkpoint comes from the command\'s sync after the write: ' + JSON.stringify(stale.snapshotTrace[0].callers));
  const observedAt = fixtureDatabase(presenceFile, db => db.prepare('SELECT at FROM heartbeat WHERE seat=?').get(heartbeat[0].seat).at);
  assert.notEqual(observedAt, agedAt, 'the successful native write really refreshed the heartbeat');
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const stateResponse = await fetch(box.origin + '/api/v1/boards/' + link.board + '/state', {
    headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(stateResponse.status, 200, 'the ordinary linked device can read its acknowledged checkpoint');
  const saved = (await stateResponse.json()).state;
  assert.equal(saved.sequence, stale.snapshotTrace[0].sequence);
  const opened = await unseal(decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim()), Buffer.from(saved.sealed, 'base64url'), {
    boardId: link.board, kind: 'snapshot', sequence: saved.sequence,
  });
  const plaintext = opened[0] === 0x1f && opened[1] === 0x8b ? gunzipSync(opened) : opened;
  const snapshot = JSON.parse(new TextDecoder().decode(plaintext));
  const published = snapshot.presentation.state.agents.find(agent => agent.agent_id === 'coordinator');
  assert.equal(published.heartbeatAt, observedAt, 'the one uploaded checkpoint contains the refreshed heartbeat');
  for (const result of [fresh, aged, stale]) for (const entry of result.snapshotTrace) {
    assert.equal(entry.status, 200);
    assert.equal(entry.abort, null, 'a presentation refresh is not a timed-out transport retry');
  }
});
