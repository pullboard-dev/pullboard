/** Native flake landing: an interrupted landing consumes its saved diagnostic [C7,H16]. */
import {
  targetRuns,
  assertReceipts,
} from '../../../../packages/git/tests/fixtures/flakes.js';
import { cliLocal } from '../../tests/fixtures/flakes/landing.js';
import { readyLanding } from '../../tests/fixtures/flakes/landing.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { openBoard } from '../../../lib/index.js';
import { land } from '../../../../packages/landing/index.js';
import { inProcessLandingBatch } from '../../../../packages/landing/index.js';
import { checkAtCommit } from '../../../runner/index.js';
import { landingPorts } from '../../tests/fixtures/landing/ports.js';

/** Interrupt the dependency at its final blocked write after real diagnostics were durably recorded, then use normal CLI adoption. */
test('an interrupted landing consumes its saved diagnostic without inventing another measurement [C7,H16]', async t => {
  const box = await readyLanding(t, true);
  // The direct public API call cannot inherit cliAt's private identity environment; set only this synthetic repo's identity.
  box.git('config', '--local', 'user.name', 'Fixture Agent');
  box.git('config', '--local', 'user.email', 'fixture@example.com');
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    // The product's own config loader reads the fixture repo's settings, as automatic landing does.
    const config = loadConfig(box.root);
    // A direct API call must not hand Node's outer test-worker protocol to its own configured Node test command.
    const context = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    let completed;
    try {
      await assert.rejects(land({ landingPorts, root: box.root, board, config, owner: 'private-interrupted-owner', say: () => {}, runBatch: inProcessLandingBatch({ checkAtCommit, candidateWorkerFile: resolve(import.meta.dirname, '../../../lib/src/io/landing/candidate.js') }),
        write: async (operation, args) => {
          if (operation === 'recordLandingBatch' && args[0].batch.state === 'blocked') throw new Error('controlled interruption after retained diagnostic');
          return board.enginePorts.store[operation](board, ...args);
        } }).then(result => { completed = result; return result; }), /controlled interruption after retained diagnostic/u);
    } catch (error) {
      const saved = store.landingBatches(board).at(-1);
      t.diagnostic(JSON.stringify({ unexpectedCompletion: completed?.batch?.state ?? null, targetRuns: targetRuns(box), savedState: saved?.state }));
      for (const gate of saved?.gateResults ?? []) if (gate.logPath) t.diagnostic(box.readData(gate.logPath, 'utf8'));
      throw error;
    } finally {
      if (context === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = context;
    }
    const saved = store.landingBatches(board).at(-1);
    assert.equal(saved.state, 'gating');
    assert.equal(saved.gateResults[0].isGreen, false);
    assert.equal(saved.gateResults[0].flakeDiagnostics.observations[0].recorded, true);
  } finally { store.closeBoard(board); }
  // Changed today with the landing rerun change: an interrupted landing has run the target once by this point.
  assert.equal(targetRuns(box), 4, 'the real interrupted landing completed its original, pair, control and base-main comparison runs');
  const adopted = await cliLocal(box, box.root, 'land', '--adopt');
  assert.equal(adopted.code, 1, JSON.stringify(adopted.document)); // the adopted batch ends blocked with every candidate a culprit
  assert.equal(adopted.document.batch.state, 'blocked');
  assert.equal(targetRuns(box), 4, 'normal adoption consumes the retained diagnostics, never a confidence rerun');
  const adoptedReport = (await cliLocal(box, box.root, 'flakes')).document;
  assert.equal(adoptedReport.flakes.length, 1, 'the retained pair is red then green, so the ledger holds one flake sighting, as the uninterrupted landing does');
  assert.equal(adoptedReport.flakes[0].observations.length, 1, 'adoption does not invent a second sighting');
  assert.equal(adoptedReport.flakes[0].count, 1);
  assert.deepEqual(adoptedReport.stable, []);
  assert.equal(box.git('--git-dir=' + box.remote, 'rev-parse', 'main').trim(), box.base);
});
