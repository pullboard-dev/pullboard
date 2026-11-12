import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { cellLintReport } from '../cell/lints.js';
import { cellLintBaseline } from '../cell/lint/ratchet.js';
import { Refused } from '../../../../kernel/index.js';
import { gitSpawnSync } from '../../../../git/index.js';
import { scratchFolder } from '../../../../config/index.js';

const MAIN_REFS = ['refs/heads/main', 'refs/remotes/origin/main'];

/** Run Git with inherited repository selectors cleared, so a hook's GIT_DIR never redirects the read. */
function gitRun(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return gitSpawnSync(args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** Name the current main commit of the repository at root, or null when it has no main branch [C7]. */
export function mainCommit(root) {
  for (const ref of MAIN_REFS) {
    const found = gitRun(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return null;
}

/**
 * Count current main's cell debt now, from a clean temporary checkout of its exact commit [C7].
 * Ratchets compare a candidate with this computed baseline instead of a committed snapshot, so a snapshot
 * that drifted after landings can never refuse an unrelated item. Returns null when there is no main.
 */
export function mainCellLintReport(root, parsers, commit = mainCommit(root)) {
  if (!commit) return null;
  const directory = scratchFolder('pullboard-main-lints-');
  try {
    const checkout = join(directory, 'main');
    const cloned = gitRun(root, ['clone', '--quiet', '--shared', '--no-checkout', '--', root, checkout]);
    const selected = cloned.status === 0 ? gitRun(checkout, ['checkout', '--quiet', '--force', '--detach', commit]) : cloned;
    if (selected.status !== 0) throw new Refused('CELL_BASELINE', `main ${commit.slice(0, 12)} could not be checked out to count its cell debt; run git fetch, then the check again`);
    const report = cellLintReport(checkout, parsers);
    return { commit, report, baseline: cellLintBaseline(report) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
