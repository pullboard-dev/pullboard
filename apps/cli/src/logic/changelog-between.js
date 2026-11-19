/** The CHANGELOG.md sections between two versions, for pullboard update to show [C7,#1303]. */

/** A `## [x.y.z] - date` heading, the form CHANGELOG.md uses for each release. */
const HEADING = /^## \[(\d+(?:\.\d+)*)\]/gmu;

/** A dotted version as numbers, so 0.9.10 sorts after 0.9.9. */
function parts(version) {
  return String(version).replace(/^v/u, '').split('.').map(Number);
}

/** Negative when a is older than b, zero when equal, positive when newer. */
function compare(a, b) {
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/**
 * The sections newer than `from`, up to and including `to`, in the order the file lists them; '' when there are none.
 * Why: an update shows what changed between the installed version and the new one, nothing older and nothing newer.
 * @param {string} text the CHANGELOG.md text
 * @param {string} from the installed version
 * @param {string} to the version being installed
 */
export function changelogBetween(text, from, to) {
  const heads = [...String(text).matchAll(HEADING)].map(match => ({ version: match[1], start: match.index }));
  return heads
    .map((head, index) => ({ ...head, end: heads[index + 1]?.start ?? text.length }))
    .filter(({ version }) => compare(version, from) > 0 && compare(version, to) <= 0)
    .map(({ start, end }) => text.slice(start, end).trimEnd())
    .join('\n\n');
}
