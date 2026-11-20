import { fileSystemAdapter } from '../../../../fs/index.js';
const disk = fileSystemAdapter();
import { join } from 'node:path';
import { readCellLintBaseline } from '../cell/lint/store.js';
import { CELL_BASELINE_DESCRIPTOR } from '../cell/lint/store.js';
import { cellLintReport } from '../cell/lints.js';
import { cellLintBaseline } from '../cell/lint/ratchet.js';
import { cellLintGrowth } from '../cell/lint/ratchet.js';
import { cachedCellsRun } from '../cells/cache.js';
import { strayNextStep } from '../../logic/allowlist.js';
import { fileURLToPath } from 'node:url';
import { Refused } from '../../../../kernel/index.js';
import { gitSpawnSync } from '../../../../git/index.js';
import { scratchBase } from '../../../../kernel/light.js';
import { environmentAdapter } from '../../../../env/index.js';

const MAIN_REFS = ['refs/heads/main', 'refs/remotes/origin/main'];

/** Run Git with inherited repository selectors cleared, so a hook's GIT_DIR never redirects the read. */
function gitRun(cwd, args) {
  const env = Object.fromEntries(Object.entries(environmentAdapter().all()).filter(([name]) => !name.startsWith('GIT_')));
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
 * When main commits a baseline, that committed snapshot is the allowance, so a landing that skipped the check
 * cannot raise it; counted debt stands in only when main has none. Returns null when there is no main.
 */
export function mainCellLintReport(root, parsers, commit = mainCommit(root)) {
  if (!commit) return null;
  const directory = disk.mkdtemp(join(scratchBase(), 'pullboard-main-lints-'));
  try {
    const checkout = join(directory, 'main');
    const cloned = gitRun(root, ['clone', '--quiet', '--shared', '--no-checkout', '--', root, checkout]);
    const selected = cloned.status === 0 ? gitRun(checkout, ['checkout', '--quiet', '--force', '--detach', commit]) : cloned;
    if (selected.status !== 0) throw new Refused('CELL_BASELINE', `main ${commit.slice(0, 12)} could not be checked out to count its cell debt; run git fetch, then the check again`);
    const report = cellLintReport(checkout, parsers);
    // The committed snapshot is the authority when main has one; main's counted debt only stands in when it has none [C7,CD23].
    const committed = disk.exists(join(checkout, CELL_BASELINE_DESCRIPTOR)) ? readCellLintBaseline(checkout) : null;
    return { commit, report, baseline: committed ?? cellLintBaseline(report), committed: Boolean(committed) };
  } finally {
    disk.rm(directory, { recursive: true, force: true });
  }
}

/**
 * Check root against main's committed cell baseline and report each rise through emit; returns the exit code [C7,CD23].
 * It lives here so the script and its test share one body; code names the files whose change voids the cached answer.
 */
export function checkCellLints(root, parsers, emit, { code = [], build = () => cellLintReport(root, parsers) } = {}) {
  const main = mainCommit(root);
  return cachedCellsRun(root, ['cell-lints', '--check', main ?? 'no-main'], () => {
    // A committed baseline must stay hash-bound to its shards: an edit without a rebind refuses here, not only in --report [C7].
    if (disk.exists(join(root, CELL_BASELINE_DESCRIPTOR))) { try { readCellLintBaseline(root); } catch (error) { emit(error.message); return 1; } }
    const current = build(), base = mainCellLintReport(root, parsers, main);
    if (!base) { emit('no main branch to compare with; nothing can rise'); return 0; }
    // Advisory transition authority comes only from main, as in the submit check.
    current.transition = base.report.transition;
    const problems = cellLintGrowth(current, base.baseline);
    for (const row of problems) emit(`${row.advisory ? `advisory item #${row.item} until #${row.until}: ` : ''}${row.metric}:${row.key}: ${row.actual} exceeds ${row.allowed} on main ${base.commit.slice(0, 12)}${row.metric === 'strays' ? `; next: ${strayNextStep(row.key)}` : ''}`);
    return problems.some(row => !row.advisory) ? 1 : 0;
  }, { code: [fileURLToPath(import.meta.url), ...code] });
}
