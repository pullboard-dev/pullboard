/** Where local work ranks among the roadmap's releases, read from the projection alone, so health reads it without the landing shell [C7]. */

/**
 * Rank local work using the board's own verified-item completion. A repo-qualified reference
 * cannot pin this board to an old milestone: its state belongs to another board and is not read.
 *
 * @param {{ items: { id: number|string, status: string }[] }[]} releases - Public roadmap projection.
 * @param {string|number} item - The local item id.
 * @returns {number} Current, later, completed earlier, then unplanned.
 */
export function localReleaseRank(releases, item) {
  const local = releases.map(release => release.items.filter(entry => typeof entry.id === 'number'));
  const first = local.findIndex(items => items.some(entry => entry.status !== 'verified'));
  const current = first < 0 ? 0 : first;
  const ranks = local.flatMap((items, index) => items.some(entry => String(entry.id) === String(item))
    ? [index >= current ? index - current : releases.length + index] : []);
  return ranks.length ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER;
}
