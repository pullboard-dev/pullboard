/** SQLite fixture boards default to memory; disk is an explicit boundary contract, and the fixture opens boards through the board composition root, never an app [C7]. */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Refused } from '../../../kernel/light.js';
import { closeBoard } from '../../index.js';
import { openBoard } from '../../index.js';
import { temporaryDirectory } from '../../../store/tests/fixtures/tmp.js';

export { openBoard, temporaryDirectory };
/** The one place this fixture opens the production board: the kit's openers and the contract fixture share it. */
function openAt(file, clock, options) {
  return openBoard(file, clock, options);
}

const FILE_PURPOSES = new Set(['persistence', 'locking', 'migration']);

/**
 * Open the production schema and moves in memory, with cleanup owned by the test.
 * A file requires a named database boundary; an unsupported mode never silently falls back.
 */
export function fixtureBoard(t, { clock, storage = 'memory', purpose, file: existing } = {}) {
  if (storage !== 'memory' && storage !== 'file') {
    throw new Refused('TEST_BOARD_STORAGE', 'choose memory, or file with a persistence, locking or migration purpose');
  }
  if ((storage === 'file' && !FILE_PURPOSES.has(purpose)) || (storage === 'memory' && purpose !== undefined)) {
    throw new Refused('TEST_BOARD_STORAGE', 'use memory for logic; file boards require a persistence, locking or migration purpose');
  }
  let file = ':memory:';
  let directory;
  if (storage === 'file' && existing) file = existing; // the caller owns this file and its folder
  else if (storage === 'file') {
    directory = temporaryDirectory('pullboard-board-contract-');
    file = join(directory, 'board.sqlite');
  }
  try {
    const board = openAt(file, clock);
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

/**
 * Open a fixture project's board in process, bound to its web checkout.
 *
 * Why: in-process board reads go through the kit seam instead of opening the file by hand.
 *
 * @param {object} box - The e2e project (boardFile, web).
 * @returns {object} The open board; the caller closes board.db.
 */
export function fixtureOpenBoard(box) {
  return openAt(box.boardFile, undefined, { gitRoot: box.web });
}

/**
 * Open a board file in process with an optional clock; the caller closes it.
 *
 * Why: the cell fixture opens real boards through this one kit seam, so no cell test opens the store by hand.
 *
 * @param {string} file - The board.sqlite path, or ':memory:'.
 * @param {{ now: () => Date }} [clock] - The board clock; the native clock when omitted.
 * @param {object} [options] - openBoard options such as gitRoot.
 * @returns {object} The open board.
 */
export function openKitBoard(file, clock, options) {
  return openAt(file, clock, options);
}

/**
 * Open a board file in process, hand it to the body, and close it after, even when the body throws.
 *
 * Why: tests that read or seed a board file they did not build as a project still go through the kit seam.
 *
 * @param {string} file - The board.sqlite path; a new file is created when it does not exist.
 * @param {(board: object) => any} body - Receives the open board; may return a promise.
 * @returns {Promise<any>|any} What the body returns.
 */
export function withFixtureBoard(file, body) {
  const board = openAt(file);
  let result;
  try { result = body(board); }
  catch (error) { closeBoard(board); throw error; }
  if (result && typeof result.then === 'function') return Promise.resolve(result).finally(() => closeBoard(board));
  closeBoard(board);
  return result;
}
