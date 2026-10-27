/** SQLite fixture boards default to memory; disk is an explicit boundary contract [C7]. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBoard, closeBoard } from '../src/board.js';
import { Refused } from '../src/refused.js';

const FILE_PURPOSES = new Set(['persistence', 'locking', 'migration']);

/**
 * Open the production schema and moves in memory, with cleanup owned by the test.
 * A file requires a named database boundary; an unsupported mode never silently falls back.
 */
export function fixtureBoard(t, { clock, storage = 'memory', purpose } = {}) {
  if (storage !== 'memory' && storage !== 'file') {
    throw new Refused('TEST_BOARD_STORAGE', 'choose memory, or file with a persistence, locking or migration purpose');
  }
  if ((storage === 'file' && !FILE_PURPOSES.has(purpose)) || (storage === 'memory' && purpose !== undefined)) {
    throw new Refused('TEST_BOARD_STORAGE', 'use memory for logic; file boards require a persistence, locking or migration purpose');
  }
  let file = ':memory:';
  let directory;
  if (storage === 'file') {
    directory = mkdtempSync(join(tmpdir(), 'pullboard-board-contract-'));
    file = join(directory, 'board.sqlite');
  }
  try {
    const board = openBoard(file, clock);
    t.after(() => {
      try { closeBoard(board); }
      finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
    });
    return board;
  } catch (error) {
    if (directory) rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
