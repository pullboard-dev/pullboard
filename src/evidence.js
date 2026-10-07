/** Read-only links between spec rows, their tests, board items and sign-offs. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * A copy of the current environment without Git's repository overrides, so a scan always reads the
 * requested checkout rather than a parent process's worktree.
 *
 * @returns {NodeJS.ProcessEnv}
 */
function gitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

/**
 * Whether a tracked path is a conventional, visible test path.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isConventionalTestPath(path) {
  const parts = path.split('/');
  if (parts.some((part) => part.startsWith('.') || part.toLowerCase() === 'kits' || part.toLowerCase() === 'hidden-tests')) return false;
  return parts.includes('test') || parts.includes('tests') || /\.(?:test|spec)\.[^/]+$/u.test(path);
}

/**
 * The tracked conventional test files and their index text, in Git's path order.
 *
 * @param {string} root
 * @returns {{ path: string, text: string }[]}
 */
export function citedTestFiles(root) {
  const cwd = resolve(root);
  const env = gitEnvironment();
  let paths;
  try {
    paths = execFileSync('git', ['-C', cwd, 'ls-files', '-z'], { env, encoding: 'utf8' })
      .split('\0')
      .filter((path) => path && isConventionalTestPath(path));
  } catch {
    return [];
  }
  const files = [];
  for (const path of paths) {
    try {
      const text = execFileSync('git', ['-C', cwd, 'show', `:${path}`], { env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
      files.push({ path, text });
    } catch {
      // An unmerged or otherwise unreadable index entry is not evidence.
    }
  }
  return files;
}

/**
 * Whether a conventional bracketed citation tag includes this exact spec id.
 *
 * @param {string} text
 * @param {string} id
 * @returns {boolean}
 */
function containsCitation(text, id) {
  for (const [, tag] of text.matchAll(/\[([^\[\]]+)\]/gu)) {
    if (tag.split(',').map((part) => part.trim()).includes(id)) return true;
  }
  return false;
}

/**
 * Evidence for one spec row from tracked tests and board snapshots.
 *
 * @param {string} root
 * @param {string} id
 * @param {{ items?: any[], verdicts?: any[], testFiles?: { path: string, text: string }[] }} [options]
 * @returns {{ files: string[], verified: { id: number, note: string }[], building: boolean, awaiting: boolean }}
 */
export function rowEvidence(root, id, { items = [], verdicts = [], testFiles } = {}) {
  const files = (testFiles ?? citedTestFiles(root))
    .filter((file) => containsCitation(file.text, id))
    .map((file) => file.path);
  const citing = items.filter((item) => (item.item_spec_ids ?? '').split(',').map((part) => part.trim()).includes(id));
  const verified = citing
    .filter((item) => item.item_status === 'verified')
    .map((item) => {
      const accepted = verdicts
        .map((verdict, index) => ({ verdict, index }))
        .filter(({ verdict }) => verdict.item_id === item.item_id && verdict.verdict_decision === 'ACCEPT')
        .sort((first, second) => (Number(first.verdict.verdict_id) || first.index) - (Number(second.verdict.verdict_id) || second.index));
      const last = accepted.at(-1)?.verdict;
      const note = typeof last?.verdict_note === 'string' ? last.verdict_note.split(/\r?\n/u, 1)[0] : '';
      return { id: item.item_id, note };
    });
  return {
    files,
    verified,
    building: citing.some((item) => ['open', 'claimed'].includes(item.item_status)),
    awaiting: citing.some((item) => item.item_status === 'submitted'),
  };
}

/**
 * The most actionable state for a spec row, with stale sign-offs taking precedence.
 *
 * @param {{ stale?: any[] } | null | undefined} standing
 * @param {{ files?: string[], verified?: any[], building?: boolean, awaiting?: boolean }} evidence
 * @returns {'stale' | 'awaiting a verdict' | 'building' | 'verified and ready to sign' | 'no evidence'}
 */
export function rowStage(standing, evidence) {
  if (standing?.stale?.length) return 'stale';
  if (evidence?.awaiting) return 'awaiting a verdict';
  if (evidence?.building) return 'building';
  if (evidence?.files?.length || evidence?.verified?.length) return 'verified and ready to sign';
  return 'no evidence';
}
