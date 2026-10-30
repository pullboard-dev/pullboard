/** Measured real HTTP fault behavior for the private relay study [H5,H17]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { openBoard } from '../src/native-board.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { faultProxy } from './relay-study-fixture.js';

test('relay study measures native reads and local moves across private transport failures [H5,H17]', { timeout: 300_000 }, async t => {
  for (const fault of ['down', 'slow-5s', '5xx', 'stale-engine']) {
    const box = await relayClientFixture(t);
    await box.link();
    const proxy = fault === 'down' ? null : await faultProxy(t, box);
    if (fault === 'down') await box.stopRelay();
    else proxy.set({ delayMs: fault === 'slow-5s' ? 5000 : 0,
      status: fault === '5xx' ? 503 : fault === 'stale-engine' ? 409 : null,
      code: fault === 'stale-engine' ? 'ENGINE_VERSION' : 'RELAY_UNAVAILABLE' });
    const before = box.calls.length;
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
    t.diagnostic(JSON.stringify({ phase: 'native-transport-failure', fault, statusMs, statusExit: status.code,
      statusErrorCode: status.document?.error?.code ?? null, moveMs, moveExit: move.code,
      moveErrorCode: move.document?.error?.code ?? null, censoredAtExistingFixtureDeadline: censored,
      requestedMoveRecorded: recorded,
      queuedMoves: saved.outbox?.moves?.length ?? 0, pending: Boolean(saved.pending),
      requests: box.calls.slice(before).map(call => ({ method: call.method, path: call.path })),
      limitation: fault === 'stale-engine' ? 'Injected real HTTP409 ENGINE_VERSION response; current CLI binary itself remains current.'
        : 'Private real HTTP failure; this stage measures native CLI only, not browser behavior.' }));
    proxy?.set();
    if (fault === 'down') await box.restartRelay();
  }
});
