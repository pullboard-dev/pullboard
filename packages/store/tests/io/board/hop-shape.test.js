/** @pullboard-test-input source-cell store */
/** A board that has the gate hop table opens current on every path: the fenced hop's table never reads as a change made outside pullboard [C7,#8465]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeBoard } from '../../../index.js';
import { register } from '../../../index.js';
import { ensureGateHopTable } from '../../../src/io/board/hop.js';
import { GATE_HOP_SCHEMA_SQL } from '../../../src/io/board/hop.js';
import { boardStanding } from '../../../src/io/board/migrate.js';
import { SCHEMA_DIGEST } from '../../../src/io/board/schema/source.js';
import { SCHEMA_VERSION } from '../../../src/io/board/schema/source.js';
import { openKitBoard } from '../../fixtures/cell.js';
import { temporaryDirectory } from '../../fixtures/tmp.js';

/** A real, current board file with one registered seat, as trunk code leaves it. */
function currentBoard(t) {
  const directory = temporaryDirectory('pullboard-hop-shape-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'board.sqlite');
  const board = openKitBoard(file);
  try { register(board, { lane: 'coordinator', path: directory }); } finally { closeBoard(board); }
  return file;
}

/** The board file's standing against this code and its row counts, read without pullboard. */
function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      standing: boardStanding(db, SCHEMA_DIGEST, SCHEMA_VERSION),
      hop: Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gate_hop'").get()),
      events: db.prepare('SELECT count(*) AS n FROM event').get().n,
      agents: db.prepare('SELECT count(*) AS n FROM agent').get().n,
    };
  } finally { db.close(); }
}

/** Open the board from the main path, collecting every diagnostic line it prints. */
function openMain(file) {
  const lines = [];
  const board = openKitBoard(file, undefined, { onDiagnostic: line => lines.push(line) });
  closeBoard(board);
  return lines;
}

test('clause 1: a current board that gains the gate_hop table through the fenced hop stays current, with no shape-drift line [C7]', t => {
  const file = currentBoard(t);
  assert.equal(inspect(file).standing, 'current');
  const db = new DatabaseSync(file);
  try { ensureGateHopTable(db); } finally { db.close(); }
  const after = inspect(file);
  assert.equal(after.hop, true);
  assert.equal(after.standing, 'current');
  assert.deepEqual(openMain(file).filter(line => /different shape/u.test(line)), []);
  assert.equal(inspect(file).standing, 'current');
});

test('clause 2: a board stamped before gate_hop was created without a restamp reopens current from the main path and keeps every row [C7]', t => {
  const file = currentBoard(t);
  const before = inspect(file);
  // The live board's state: the hop table made by code that did not restamp, so the stored stamp predates it.
  const db = new DatabaseSync(file);
  try { db.exec(GATE_HOP_SCHEMA_SQL); } finally { db.close(); }
  assert.equal(inspect(file).standing, 'drifted');
  assert.deepEqual(openMain(file).filter(line => /different shape/u.test(line)), []);
  const after = inspect(file);
  assert.equal(after.standing, 'current');
  assert.equal(after.hop, true);
  assert.equal(after.agents, before.agents);
  assert.ok(after.events >= before.events);
});
