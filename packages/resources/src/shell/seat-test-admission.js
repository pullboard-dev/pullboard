/** Direct test admission keeps seat ownership separate from gate/verdict capacity [C7,#2831]. */
import { repoInfo } from '../../../git/index.js';

/** Recognize both the CLI test kind and the standalone runner's explicit seat-test kind. */
export function isSeatTest(kind) { return kind === 'test' || kind === 'seat-test'; }

/** Use one shared Git identity across item worktrees while retaining the displayed native agent id. */
export function seatTestRepo(root, fallback) {
  try { return repoInfo(root).commonDir; } catch { return fallback; }
}

/** Read occupied seat test identities from the same transaction that admits local and remote holders. */
export function holdingTestSeats(db) {
  return new Set(db.prepare("SELECT agent, repo FROM holder WHERE (name = 'gate' OR name GLOB 'runner:*') AND kind IN ('test','seat-test')").all()
    .map(holder => JSON.stringify([holder.repo, holder.agent])));
}

/** Resolve the ordinary resource repository without making a non-Git caller an admission failure. */
export function repoRoot(root) {
  try { return repoInfo(root).root; } catch { return ''; }
}
