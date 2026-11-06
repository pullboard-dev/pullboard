/** The browser tab title, built in one place from the tab and the board shown [N26,N38]. */

/**
 * Name the shown board and tab: the remaining count on Roadmap, the Cost label on Cost and the person-call count
 * on every other tab. With no board or project group shown the tab is plain Pullboard. The page embeds this source.
 *
 * @param {{ shown?: boolean, name?: string, tab?: string, group?: boolean, needs?: number, remaining?: number|null, cost?: boolean }} place
 * @returns {string}
 */
export function tabTitle({ shown = false, name = '', tab = 'dashboard', group = false, needs = 0, remaining = null, cost = false } = {}) {
  if (!shown) return 'Pullboard';
  if (tab === 'roadmap' && !group) return (remaining === null ? '' : '(' + remaining + ' remaining) ') + name + ' · Roadmap · Pullboard';
  if (tab === 'cost' && cost) return name + ' · Cost · Pullboard';
  return (needs ? '(' + needs + ') ' : '') + name + ' · Pullboard';
}
