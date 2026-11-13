/** Exercise the public recovery entrance with real private link persistence and native SQLite [H16,H21]. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { lossFixture } from './relay-outbox-rebuild-recovery.test.js';
import { relayDiscardUnpublished, saveLink } from '../src/relay.js';
import { seal } from '../src/seal.js';
import { engineReceipt } from '../src/engine.js';
import { outboxFile } from '../src/relay-outbox.js';
import { exportBoard } from '../src/exchange.js';

for (const cut of ['none', 'held', 'archived']) test(`installed API recovery ${cut}: actual binding, locks and persisted link [H16,H21]`, async t => {
  const f = await lossFixture(t, { fileBacked: true });
  Object.assign(f.link.state, { version: 1, url: 'https://relay.example.invalid', cursor: 0, token: 'pm_' + 'a'.repeat(43) });
  saveLink(f.link.file, f.link.state);
  const snapshot = { sequence: f.checkpoint.sequence, sender: { kind: 'machine', userId: 'fixture', machine: 'fixture-machine' },
    sealed: Buffer.from(await seal(f.key, Buffer.from(JSON.stringify(f.checkpoint.native)), { boardId: f.id, kind: 'snapshot', sequence: f.checkpoint.sequence })).toString('base64url') };
  const calls = [], previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async (url, options) => {
    const u = new URL(url); calls.push({ method: options.method, path: u.pathname + u.search });
    assert.equal(u.origin, 'https://relay.example.invalid'); assert.equal(options.method, 'GET');
    assert.equal(options.headers.authorization, 'Bearer ' + f.link.state.token);
    if (u.pathname.endsWith('/state')) return Response.json({ version: 1, state: snapshot });
    assert.equal(u.pathname, '/api/v1/boards/' + f.id + '/events');
    const after = Number(u.searchParams.get('after'));
    return Response.json({ version: 1, events: f.records.filter(row => row.event_id > after) });
  };
  const io = { err() {}, out() {}, ignoreRelayEnvironmentToken: true };
  if (cut !== 'none') {
    io.recoveryCut = name => { if (name === cut) throw new Error('fixture API interruption'); };
    await assert.rejects(relayDiscardUnpublished(f.link.root, f.choice.queueSha256, f.choice.decision, io), /fixture API interruption/);
    delete io.recoveryCut;
  }
  const result = await relayDiscardUnpublished(f.link.root, f.choice.queueSha256, f.choice.decision, io);
  assert.equal(result.sequence, 3); assert.equal(result.nativeEventCursor, f.board.db.prepare('SELECT max(event_id) AS id FROM event').get().id);
  assert.deepEqual(engineReceipt(f.board, f.third.id), f.receipt);
  assert.equal(engineReceipt(f.board, f.fourth.id), null);
  assert.deepEqual(readFileSync(result.archive), f.queue); assert.equal(existsSync(outboxFile(f.link.file)), false);
  const before = exportBoard(f.board), count = calls.length;
  assert.equal((await relayDiscardUnpublished(f.link.root, f.choice.queueSha256, f.choice.decision, io)).alreadyCompleted, true);
  assert.equal(calls.length, count); assert.deepEqual(exportBoard(f.board), before);
});
