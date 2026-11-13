/** The synthetic board submit for fixtures: the store's own submit with a deferred proof, no gate run [C7,V4]. */
import { sep } from 'node:path';
import { submit } from '../../index.js';

/**
 * Name the repository of a board opened from `<repo>/.git/pullboard/board.sqlite`, as the native CLI does.
 * Since #2050 a file board must know its repository to seal accepted main's clause policy; in-memory
 * and repository-less boards are left as opened, so their own fixtures decide [V4,C7].
 */
function bindBoardRepository(board) {
  if (board.gitRoot) return;
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  const marker = `${sep}.git${sep}pullboard${sep}`;
  const at = file ? file.lastIndexOf(marker) : -1;
  if (at > 0) board.gitRoot = file.slice(0, at);
}

/**
 * Record a synthetic board move without claiming that this fixture ran a gate.
 *
 * A native CLI step just before (a claim) can leave a background process committing to the same board while the submit
 * seals its repository reads; submit then refuses BOARD_BUSY and says to retry from the current snapshot, so this does,
 * a few times, and no other refusal is retried.
 */
export function submitFixture(board, id, options) {
  bindBoardRepository(board);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return submit(board, id, {
        submissionProof: { version: 1, files: [], full: false, deferred: true,
          reason: 'synthetic board-state fixture; no gate execution' },
        ...options,
      });
    } catch (error) {
      if (error?.code !== 'BOARD_BUSY' || attempt >= 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * attempt);
    }
  }
}
