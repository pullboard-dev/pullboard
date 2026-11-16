/** The markdown allowlist: only listed .md files may be committed, every entry carries a reason [C7]. */

/** The one allowlist file: patterns with reasons. A permanent entry stays; a temporary one names the item that drops its file. */
export const MARKDOWN_ALLOWLIST = 'packages/gate/data/ceilings/markdown-allowlist.json';

/** The fix every refusal ends with. */
const FIX = `delete it, move its content into CLI help or a skill (skills/<name>/SKILL.md), or add an entry with a reason to ${MARKDOWN_ALLOWLIST}`;

/**
 * Turn an allowlist pattern into a matcher: `*` stands for any run of characters inside one path segment, nothing else is special.
 *
 * @param {string} pattern - Repo-relative pattern such as `docs/rfcs/*.md`.
 * @returns {RegExp}
 */
function patternMatcher(pattern) {
  return new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*')}$`, 'u');
}

/**
 * One problem per tracked .md file no entry allows, and one per entry with no reason or no pattern.
 * Why: one source of truth; prose beside the code drifts, so a new .md must be argued for in the one list [C7].
 *
 * @param {string} source - The allowlist file's text.
 * @param {string[]} files - Every tracked or staged repo-relative path; only .md ones are judged.
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function markdownProblems(source, files) {
  let entries;
  try { entries = JSON.parse(source).entries; } catch { entries = null; } // unreadable JSON is reported below, as a refusal
  if (!Array.isArray(entries)) return [{ path: MARKDOWN_ALLOWLIST, line: 1, text: 'the markdown allowlist is not a JSON object with an "entries" list; restore it from main' }];
  const problems = [];
  const matchers = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry?.pattern !== 'string' || !entry.pattern) problems.push({ path: MARKDOWN_ALLOWLIST, line: 1, text: `entry ${index + 1} names no file pattern; give it a "pattern"` });
    else if (typeof entry.reason !== 'string' || !entry.reason.trim()) problems.push({ path: MARKDOWN_ALLOWLIST, line: 1, text: `the entry for ${entry.pattern} has no reason; write why this .md file may exist` });
    else matchers.push(patternMatcher(entry.pattern));
  }
  for (const file of files) {
    if (/\.md$/u.test(file) && !matchers.some(matcher => matcher.test(file))) problems.push({ path: file, line: 1, text: `this .md file is not on the allowlist; ${FIX}` });
  }
  return problems;
}
