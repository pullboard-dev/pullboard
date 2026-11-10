/** Change-based sync measured against whole checkpoints [H5,H17]. Run it explicitly: the default gate skips *.study.js. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import { relayClientFixture } from '../../../../cli/tests/fixtures/relay/client.js';
import { readRelay } from '../../../../../packages/pages/tests/fixtures/study.js';

/** Sum the request or response bytes of transit rows that match one route. */
function bytes(rows, pick, side) {
  return rows.filter(pick).reduce((sum, row) => sum + row[side].byteLength, 0);
}

test('relay study measures one sealed move against its checkpoint at 10k and 50k events [H5,H17]', { timeout: 300_000 }, async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  for (const target of [10_000, 50_000]) {
    let events = board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
    store.atomic(board, () => {
      while (events < target) {
        const text = 'Study event ' + events + ' ' + createHash('sha256').update(String(events)).digest('hex');
        store.shout(board, { from: 'coordinator', to: 'all', text, lanes: [box.lane] });
        events++;
      }
    });
    assert.equal((await box.cli('status')).code, 0, 'the seeded scale is published before the probe move');
    const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
    const before = box.transit.length;
    const started = performance.now();
    const move = await box.cli('shout', 'all', 'delta probe at ' + target);
    const moveMs = performance.now() - started;
    assert.equal(move.code, 0, 'the probe move is recorded through the linked CLI');
    const rows = box.transit.slice(before);
    const isMove = row => row.method === 'POST' && /\/api\/v1\/boards\/[0-9a-f]{32}\/moves$/u.test(row.path);
    const isUpload = row => ['PUT', 'POST'].includes(row.method) && row.path.startsWith('/api/v2/');
    const headers = { authorization: 'Bearer ' + state.token, 'x-pullboard-engine': String(ENGINE_VERSION) };
    const deltaStarted = performance.now();
    const delta = await fetch(box.origin + '/api/v1/boards/' + state.board + '/events?after=' + state.sequence, { headers });
    const deltaBody = Buffer.from(await delta.arrayBuffer());
    const deltaReadMs = performance.now() - deltaStarted;
    const full = await readRelay(box);
    t.diagnostic(JSON.stringify({ phase: 'delta-versus-checkpoint', events: target + 1, node: process.versions.node,
      moveMs, movePosts: rows.filter(isMove).length, moveRequestBytes: bytes(rows, isMove, 'request'),
      checkpointRequests: rows.filter(isUpload).length, checkpointRequestBytes: bytes(rows, isUpload, 'request'),
      allRequestBytes: bytes(rows, () => true, 'request'), allResponseBytes: bytes(rows, () => true, 'response'),
      deltaReadStatus: delta.status, deltaReadError: delta.status === 200 ? null : JSON.parse(deltaBody.toString('utf8')).error ?? null, deltaReadBytes: deltaBody.byteLength, deltaReadMs,
      fullReadRequests: full.requests, fullReadBytes: full.receivedBytes, fullReadMs: full.readMs,
      scope: 'Private loopback relay, foreground checkpoint (PULLBOARD_RELAY_CHECKPOINT_BACKGROUND=0), one shout move.' }));
    // Measured: a checkpoint compacts the moves behind it, so a reader behind it is told SNAPSHOT_REQUIRED.
    assert.ok([200, 409].includes(delta.status), 'the relay answers the reader cursor with moves or a snapshot demand');
  }
});
