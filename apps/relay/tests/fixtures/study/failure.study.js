/** Measured real HTTP fault behavior for the private relay study [H5,H17]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { relayClientFixture } from '../../../../cli/tests/fixtures/relay/client.js';
import { faultProxy } from '../../../../../packages/pages/tests/fixtures/study.js';
import { readRelay } from '../../../../../packages/pages/tests/fixtures/study.js';
import { CHECKPOINT_BACKGROUND_ENV } from '../../../../../packages/outbox/index.js';

test('relay study measures native reads and local moves across private transport failures [H5,H17]', { timeout: 300_000 }, async t => {
  for (const fault of ['down', 'slow-5s', '5xx', 'stale-engine']) {
    const box = await relayClientFixture(t);
    await box.link();
    const proxy = fault === 'down' ? null : await faultProxy(t, box);
    if (fault === 'down') await box.stopRelay();
    else proxy.set({ delayMs: fault === 'slow-5s' ? 5000 : 0,
      status: fault === '5xx' ? 503 : fault === 'stale-engine' ? 409 : null,
      code: fault === 'stale-engine' ? 'ENGINE_VERSION' : 'RELAY_UNAVAILABLE' });
    if (fault === 'slow-5s') {
      // #1285 measures the product default, rather than the runner's explicit inline-publisher override.
      delete box.env[CHECKPOINT_BACKGROUND_ENV];
      box.holdPublishes(true);
      t.after(() => box.holdPublishes(false));
    }
    const before = box.calls.length;
    const publish = /\/uploads\/[^/]+\/publish$/u;
    const uploadsBefore = box.transit.filter(entry => publish.test(entry.path)).length;
    const started = performance.now();
    const status = await box.cli('status');
    const statusMs = performance.now() - started;
    const writeStarted = performance.now();
    const title = 'Study move during ' + fault;
    let move, censored = false;
    try { move = await box.cli('add', box.lane, title); }
    catch (error) {
      if (!/upload-derived child deadline 55000ms exceeded/u.test(error.message)) throw error;
      censored = true;
      move = { code: null, document: null };
    }
    const moveMs = performance.now() - writeStarted;
    const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
    let recorded;
    try { recorded = store.listItems(board, { all: true }).filter(item => item.item_title === title).length; }
    finally { store.closeBoard(board); }
    const saved = JSON.parse(readFileSync(box.linkFile, 'utf8'));
    const requests = box.calls.slice(before).map(call => ({ method: call.method, path: call.path }));
    if (fault === 'slow-5s') {
      assert.equal(censored, false, 'the default command returns within the unchanged child deadline');
      assert.equal(move.code, 0, JSON.stringify(move.document));
      assert.equal(recorded, 1, 'the acknowledged requested item is recorded exactly once');
      assert.equal(saved.pending, undefined, 'the ordered move acknowledgment clears pending delivery');
      assert.equal(saved.outbox?.moves?.length ?? 0, 0, 'the acknowledged move needs no outbox retry');
      assert.equal(box.transit.filter(entry => publish.test(entry.path)).length, uploadsBefore,
        'the add returned before its held checkpoint upload completed');
      proxy.set();
      const beforeUpload = await readRelay(box);
      assert.equal(beforeUpload.document.tables.item.filter(item => item.item_title === title).length, 0,
        'the decrypted relay checkpoint still precedes the acknowledged add');
      box.holdPublishes(false);
      box.env[CHECKPOINT_BACKGROUND_ENV] = '0';
      const synced = await box.cli('relay');
      assert.equal(synced.code, 0, JSON.stringify(synced.document));
      const afterUpload = await readRelay(box);
      assert.equal(afterUpload.document.tables.item.filter(item => item.item_title === title).length, 1,
        'the authenticated encrypted checkpoint eventually contains exactly one requested item');
    }
    t.diagnostic(JSON.stringify({ phase: 'native-transport-failure', fault, statusMs, statusExit: status.code,
      statusErrorCode: status.document?.error?.code ?? null, moveMs, moveExit: move.code,
      moveErrorCode: move.document?.error?.code ?? null, censoredAtExistingFixtureDeadline: censored,
      requestedMoveRecorded: recorded,
      queuedMoves: saved.outbox?.moves?.length ?? 0, pending: Boolean(saved.pending),
      requests,
      checkpointMode: fault === 'slow-5s' ? 'default-background' : 'fixture-inline',
      limitation: fault === 'stale-engine' ? 'Injected real HTTP409 ENGINE_VERSION response; current CLI binary itself remains current.'
        : 'Private real HTTP failure; this stage measures native CLI only, not browser behavior.' }));
    proxy?.set();
    if (fault === 'down') await box.restartRelay();
  }
});
