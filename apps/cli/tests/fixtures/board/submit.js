/** Board-state fixtures supply the receipt required by modern submits [C7,V4]. */
import { submit } from '../../../../../packages/store/index.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  rmSync,
} from 'node:fs';
import { temporaryDirectory } from '../board.js';
import { writeFileSync } from 'node:fs';

/** Construct the existing stale-verdict check and read its exact immutable per-fixture invocation log. */
export function staleVerdictCheckFixture(directory) {
  const checkedHeads = join(directory, 'checked-heads');
  const check = `grep -q '^feature = 1$' web/feature.js && git rev-parse HEAD >> '${checkedHeads}'`;
  /** Preserve raw check-log bytes and the original missing-file failure. */
  function readCheckedHeads() {
    return readFileSync(checkedHeads, 'utf8');
  }
  return { check, readCheckedHeads };
}

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

/** Record a synthetic board move without claiming that this fixture ran a gate. */
export function submitFixture(board, id, options) {
  bindBoardRepository(board);
  return submit(board, id, {
    submissionProof: { version: 1, files: [], full: false, deferred: true,
      reason: 'synthetic board-state fixture; no gate execution' },
    ...options,
  });
}

/**
 * Make `directory` a real repository with one commit on main and return the board file inside its .git, as the native
 * CLI places it, so submit seals the repository's accepted policy instead of refusing NO_POLICY [V4,C7].
 */
export function repositoryBoardFile(directory) {
  policyRepository(directory);
  mkdirSync(join(directory, '.git', 'pullboard'));
  return join(directory, '.git', 'pullboard', 'board.sqlite');
}

/**
 * Make `directory` a real repository with one commit of policy on main and return it, for a board kept outside
 * .git that is opened with this repository as its gitRoot, so submit seals that policy instead of refusing NO_POLICY [V4,C7].
 */
export function policyRepository(directory) {
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: directory, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(directory, 'pullboard.json'), JSON.stringify({ lanes: {} }));
  git('add', 'pullboard.json');
  git('commit', '-q', '-m', 'fixture policy');
  return directory;
}

/** Make a removed-after-test policy repository (one commit on main) and return its directory [C7]. */
export function temporaryRepository(t, prefix) {
  const directory = temporaryDirectory(prefix);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return policyRepository(directory);
}
