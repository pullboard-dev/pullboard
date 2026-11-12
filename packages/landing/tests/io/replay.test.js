/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js packages/state/src/io/machine.js */
import { landingWaiverFor as nativeLandingWaiverFor } from '../../index.js';
import { waivedLandingProof as nativeWaivedLandingProof } from '../../index.js';
/** Preserve released person-waiver receipts on independent current replicas [B3,R3,H16]. */
import { landingPorts } from '../../../../apps/cli/tests/fixtures/landing/ports.js';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { openCellBoard as openBoard } from '../../../store/tests/fixtures/cell.js';
import {
  exportBoard,
  importBoard,
} from '../../../store/index.js';
import {
  applyEngineMove,
  engineReceipt,
} from '../../../state/index.js';
import { unpackRelease } from '../../../../apps/cli/tests/fixtures/release/archive.js';

/** Ignore only the current writer marker, never semantic history or ordered receipts. */
function withoutWriterMarker(document) {
  const copy = structuredClone(document);
  copy.tables.board_meta = copy.tables.board_meta.filter(row => row.meta_key !== 'relay_engine_version');
  return copy;
}

test('an actual engine12 person waiver keeps its exact receipt and history on both replicas [B3,R3,H16]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-old-waiver-'));
  const archived = join(directory, 'engine12');
  const replicas = [];
  let oldStore;
  let old;
  t.after(() => {
    for (const board of replicas) store.closeBoard(board);
    if (old) oldStore.closeBoard(old);
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(archived);
  unpackRelease('59a6e2b286ee852add0d68a659f1a1e6b3257c44', archived);
  oldStore = await import(pathToFileURL(join(archived, 'src/board.js')).href);
  const oldEngine = await import(pathToFileURL(join(archived, 'src/engine.js')).href);
  const oldExchange = await import(pathToFileURL(join(archived, 'src/exchange.js')).href);
  const oldMachine = await import(pathToFileURL(join(archived, 'src/machine.js')).href);
  assert.equal(oldMachine.ENGINE_VERSION, 12, 'use the actual released executable, not a retagged current writer');
  const at = '2026-10-17T20:00:00.000Z';
  const base = 'a'.repeat(40);
  const commit = 'b'.repeat(40);
  const digest = 'd'.repeat(64);
  old = oldStore.openBoard(':memory:', { now: () => new Date(at) });
  oldStore.ensureCoordinator(old, '/fixture');
  oldStore.register(old, { lane: 'web', path: '/fixture/builder' });
  oldStore.register(old, { lane: 'web', path: '/fixture/reviewer' });
  const item = oldStore.addItem(old, { by: 'coordinator', lane: 'web', title: 'Historical waived landing' });
  oldStore.claim(old, item, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000, head: base,
    freeze: () => ({ text: JSON.stringify({ rows: [], policy: { version: 1, commit: base,
      verify: { policy: 'any', family: 'off' } } }), digest }) });
  oldStore.submit(old, item, { agentId: 'web-1', commit, tree: commit, files: ['web/feature.js'], policyCommit: base });
  oldStore.verify(old, item, { agentId: 'web-2', decision: 'ACCEPT', note: 'Historical private proof',
    head: commit, digest, policy: 'any', familyPolicy: 'off', check: 'green' });
  const seed = oldExchange.exportBoard(old);
  for (let index = 0; index < 2; index++) {
    const board = openBoard(':memory:');
    replicas.push(board);
    importBoard(board, seed);
  }
  const move = oldEngine.prepareEngineMove(old, 'recordLandingWaiver', [{
    agentId: 'person', channel: 'terminal', id: 'legacy-waiver', test: 'test/flaky.test.js',
    until: '2099-01-01T00:00:00.000Z', reason: 'Synthetic private replay proof',
  }], { id: 'old-person-waiver' });
  const order = { sequence: 1, at };
  const original = oldEngine.applyEngineMove(old, move, order);
  assert.equal(original.error, undefined);
  assert.equal(Object.hasOwn(original.result, 'kind'), false, 'the released receipt did not store a match kind');
  const current = replicas.map(board => applyEngineMove(board, move, order));
  assert.deepEqual(current[0], current[1], 'current replicas agree');
  assert.deepEqual(exportBoard(replicas[0]), exportBoard(replicas[1]), 'current ordered prefixes agree');
  assert.deepEqual(current[0], original, 'the old move retains its released receipt shape');
  for (const board of replicas) {
    assert.deepEqual(engineReceipt(board, move.id), oldEngine.engineReceipt(old, move.id));
    assert.deepEqual(withoutWriterMarker(exportBoard(board)), withoutWriterMarker(oldExchange.exportBoard(old)));
    const before = exportBoard(board);
    assert.equal(nativeLandingWaiverFor(board, { file: 'test/flaky.test.js', name: 'unrelated behavior' }, landingPorts).kind, 'file');
    assert.equal(nativeLandingWaiverFor(board, { file: 'test/unrelated.test.js', name: 'test/flaky.test.js' }, landingPorts), null,
      'a file waiver cannot cover a test merely named like its file');
    assert.deepEqual(exportBoard(board), before, 'derived waiver classification never writes history');
    assert.deepEqual(applyEngineMove(board, move, order), original, 'retrying the old move preserves its released receipt');
  }

  // The old matcher accepted a name equal to a waived file. The current pre-push reader
  // rejects that collision, but it must still replay the older already-pushed history exactly.
  const entry = { id: item, commit, merge: commit };
  const batch = { version: 1, id: 'historical-pushed-waiver', state: 'pushed', base, tip: commit,
    root: '/fixture/landing', branch: 'refs/heads/main', owner: 'fixture', logPath: '/fixture/landing.log',
    candidates: [entry], items: [entry], revision: 0,
    proof: { tree: commit, failures: [{ file: 'test/different.test.js', name: 'test/flaky.test.js', waiver: 'legacy-waiver' }] } };
  for (const [index, [operation, args]] of [
    ['recordLandingBatch', [{ agentId: 'coordinator', batch }]],
    ['finishLandingBatch', [{ agentId: 'coordinator', id: batch.id, tip: commit }]],
  ].entries()) {
    const ordered = { sequence: index + 2, at };
    const legacy = oldEngine.prepareEngineMove(old, operation, args, { id: `historical-waiver-${operation}` });
    const result = oldEngine.applyEngineMove(old, legacy, ordered);
    assert.equal(result.error, undefined);
    for (const board of replicas) {
      assert.deepEqual(applyEngineMove(board, legacy, ordered), result, `${operation} preserves its actual released receipt`);
      assert.deepEqual(engineReceipt(board, legacy.id), oldEngine.engineReceipt(old, legacy.id));
      assert.deepEqual(withoutWriterMarker(exportBoard(board)), withoutWriterMarker(oldExchange.exportBoard(old)));
    }
  }
  assert.ok(oldStore.waivedLandingProof(old, commit), 'the released reader allowed the old name/file collision');
  for (const board of replicas) {
    const before = exportBoard(board);
    assert.equal(store.getItem(board, item).item_merged_commit, commit, 'the older pushed receipt remains recorded');
    assert.equal(nativeWaivedLandingProof(board, commit, landingPorts), null, 'new pushes cannot reuse that unsafe old proof');
    assert.deepEqual(exportBoard(board), before, 'stricter pre-push projection never rewrites ordered history');
  }
});
