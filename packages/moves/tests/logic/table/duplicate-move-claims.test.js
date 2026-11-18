/** @pullboard-test-input source-cell packages/moves */
/** The duplicate-claim check reports a journey record asserting a move row a table test owns, and only reports [C7,U148,#8394]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { duplicateMoveClaims } from '../../../index.js';

const moves = { cell: 'moves', records: { 'moves.hop.rows-fire': { proves: { move: 'hop:serve' } }, 'moves.claim.rows-fire': { proves: { move: 'claim:grant' } } } };

test('moves.duplicate-move-claims.moves-duplicate-claims-reports-row-clause-1-a-record-outside-the: moves.duplicate-claims.reports-row: clause 1: a record outside the moves cell naming an owned row is reported with the row and both test IDs [C7]', () => {
  const journey = { cell: 'cli', records: { 'cli.journey.hop-serves': { proves: { move: 'hop:serve' } } } };
  assert.deepEqual(duplicateMoveClaims([moves, journey]), [{ row: 'hop:serve', owner: 'moves.hop.rows-fire', duplicates: ['cli:cli.journey.hop-serves'] }]);
});

test('moves.duplicate-move-claims.moves-duplicate-claims-report-only-clause-2-the-check-returns-its: moves.duplicate-claims.report-only: clause 2: the check returns its findings and never refuses [C7]', () => {
  const journey = { cell: 'cli', records: { 'cli.a': { proves: { move: 'hop:serve' } } } };
  assert.doesNotThrow(() => duplicateMoveClaims([moves, journey]));
  assert.ok(Array.isArray(duplicateMoveClaims([moves, journey])));
  assert.doesNotThrow(() => duplicateMoveClaims([{ cell: 'cli', records: { x: {} } }, { cell: 'gate', records: {} }]));
});

test('moves.duplicate-move-claims.moves-duplicate-claims-distinct-rows-clean-clause-3-records-outside-the-moves: moves.duplicate-claims.distinct-rows-clean: clause 3: records outside the moves cell naming different rows give no findings [C7]', () => {
  const others = [
    { cell: 'cli', records: { 'cli.a': { proves: { move: 'hop:other' } } } },
    { cell: 'gate', records: { 'gate.b': { proves: { move: 'landing:merge' } } } },
  ];
  assert.deepEqual(duplicateMoveClaims([moves, ...others]), []);
});
