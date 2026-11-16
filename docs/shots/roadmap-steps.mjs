/**
 * The two decisions the Roadmap capture makes on a long release: which way to move the pager, and where to scroll.
 * Both are plain functions with no page access, so a unit test proves them over hundreds of rows without Chrome, and
 * demo.mjs ships their source into the page so the tested code is the code that runs [I11,C7].
 */

/**
 * Decide the next move while hunting for one item in a paged release list.
 * Why: a long release lists landed items a page at a time, so the target may sit on a later page.
 *
 * @param {{ keys: string[], target: string, nextEnabled: boolean }} state the row keys on this page, the wanted key, and whether the pager can still step on
 * @returns {'found' | 'step' | 'missing'} found: the target is on this page; step: click the pager; missing: no page left to try
 */
export function pagerAction({ keys, target, nextEnabled }) {
  if (keys.includes(target)) return 'found';
  return nextEnabled ? 'step' : 'missing';
}

/**
 * The scroll position that puts an element in the middle of the window, never above the top of the page.
 * Why: on a long release the item sits far down the page and must be inside the picture before it is measured.
 *
 * @param {{ top: number, height: number, viewport: number, scrollY: number }} box the element's top and height in the window, the window height, and the current scroll
 * @returns {number} the scroll position to use
 */
export function centerScroll({ top, height, viewport, scrollY }) {
  return Math.max(0, Math.round(scrollY + top + height / 2 - viewport / 2));
}
