/** Deterministic classification uses native submitted paths, never prose or receiver files [V4,B26,H16]. */
import { REVIEW_TIER_ENGINE } from './review-tier-engine.js';
import { ENGINE_VERSION } from './machine.js';

// Strict areas include their focused tests, without making unrelated UI/product tests Strict.
const DIRECTORIES = ['relay/', 'bin/', '.githooks/', '.husky/', '.github/workflows/', 'src/moves/',
  'src/gate/', 'src/auth/', 'src/kernel/', 'src/landing/', 'src/runner/',
  'test/gate/', 'test/auth/', 'test/relay/', 'test/kernel/', 'test/landing/', 'test/runner/'];
const FILES = new Set(['package.json', 'package-lock.json', 'pullboard.json', 'src/config.js', 'src/cli.js', 'src/cli-main.js']);
const FAMILIES = [
  'gate', 'flake', 'flakes', 'native-flake', 'native-flakes', 'ci-flake', 'ci-flakes', 'quarantine',
  'test', 'tap-tests', 'perf-budgets', 'timing', 'timed-shell', 'runner', 'runners', 'remote', 'hook', 'hooks',
  'module-imports', 'static-import-style', 'affected-tests', 'audit-coverage', 'main-audit', 'main-red', 'main-failure-matches',
  'known-main', 'review', 'next', 'queue', 'line-capacity', 'route-escalation', 'item-authors', 'item-patch',
  'required-review-family', 'verdict', 'verify', 'merge-only', 'landing', 'land', 'train', 'mechanical-merge',
  'trunk-conflict', 'computed-conflict', 'receipt', 'proof', 'pre-push', 'push-receipt', 'push-native', 'release-gate',
  'submit', 'submission', 'browser', 'gui-admission', 'cpu-load-admission', 'child-journal', 'shell-run',
  'bar', 'check', 'criterion', 'frozen', 'policy', 'trusted', 'ratchet', 'rigor', 'doctrine', 'spec',
  'auth', 'relay', 'secret', 'secrets', 'credential', 'security', 'signature', 'seal', 'sealed', 'pairing',
  'person', 'agent-grant', 'agent-session', 'parent-session', 'coordinator-hold', 'seats', 'seat',
  'kernel', 'refused', 'discovery', 'registry-guards', 'literal-shell-words', 'js-lex', 'machine',
  'engine', 'move-registry', 'recorded', 'board', 'exchange', 'submission-record',
];
const CELLS = new Set(['gate', 'flakes', 'kernel', 'state', 'moves', 'verify', 'landing', 'merge', 'runners', 'sandbox', 'keys', 'link', 'outbox', 'person']);

/** Native path families are conservative; the coordinator can mark an uncatalogued judgment change. */
export function gateJudgmentPath(path) {
  if (typeof path !== 'string') return false;
  const value = path.replace(/^\.\//u, '');
  if (/\.(?:md|mdx|rst|adoc)$/iu.test(value)) return false;
  if (FILES.has(value) || DIRECTORIES.some(prefix => value.startsWith(prefix))) return true;
  const cell = /^packages\/([^/]+)\/|^apps\/(runner|relay)\//u.exec(value);
  if (cell && (CELLS.has(cell[1]) || cell[2])) return true;
  if (!/^(?:src\/(?:commands\/)?|test\/)[^/]+\.[cm]?js$/u.test(value)) return false;
  const name = value.slice(value.lastIndexOf('/') + 1);
  return FAMILIES.some(family => name.startsWith(family + '-') || name.startsWith(family + '.'));
}

/** Native submitted file inventory is replicated; titles, briefs and the reviewer's filesystem are not authority. */
export function gateJudgmentItem(board, id) {
  const files = board.db.prepare('SELECT item_files FROM item WHERE item_id=?').get(id)?.item_files ?? '';
  return files.split('\n').some(gateJudgmentPath);
}

/** Genuine old ordered moves keep their old tier even after an upgrade. */
export function classifiedStrict(board, id) {
  return (board.executionEngineVersion ?? ENGINE_VERSION) >= REVIEW_TIER_ENGINE && gateJudgmentItem(board, id);
}

/** Once a new native prefix exists, older envelopes cannot bypass the classification it activates. */
export function reviewTierFloor(board, id) {
  if (!board) return 1;
  const active = board.db.prepare("SELECT 1 FROM board_meta WHERE meta_key='review_tier:active'").get();
  if (active) return REVIEW_TIER_ENGINE;
  const policies = id === undefined
    ? board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'review_independence:%'").all()
    : board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').all(`review_independence:${id}`);
  return policies.some(row => markedPolicy(row.meta_value)) ? REVIEW_TIER_ENGINE : 1;
}

/** Malformed policy is never an invitation to use an older engine; the policy reader supplies its typed refusal. */
function markedPolicy(text) {
  try { return JSON.parse(text).reviewTier === 'strict'; }
  catch { return true; }
}
