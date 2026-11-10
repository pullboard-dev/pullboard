import { cellReadPathMap } from '../../../../../packages/codemap/index.js';
import { mainCheckout } from '../../../../../packages/git/light.js';

const LIVE = new Set(['open', 'claimed', 'submitted', 'verified']);

/**
 * Every pre-move name of a file, from the layout freeze's path maps, following a chain of moves.
 * Why: a Main red item filed before the freeze names the file by its old path.
 */
function oldNames(root, file) {
  let moves;
  try {
    const main = mainCheckout(root);
    if (!main?.commit) return [file];
    moves = [...cellReadPathMap(root, { commit: main.commit })];
  } catch { return [file]; }
  const names = new Set([file]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [from, to] of moves) if (names.has(to) && !names.has(from)) { names.add(from); grew = true; }
  }
  return [...names];
}

/**
 * Build the known-red check `pullboard test --compare-main` uses: it answers, per file, why main need not be run for it,
 * or null when it must be. A file is a known red when an open "Main red: <file>" item (under its current or a pre-move
 * name) owns it. Recorded outcomes remain subject to the comparison receipt and content checks.
 * Why: a known red proves itself by the candidate's own result; comparing it with main waited on a second full run [C7].
 *
 * @param {string} root - The checkout root.
 * @param {() => object[]} listItems - Reads the board's items, called at most once.
 * @returns {(file: string) => string|null}
 */
export function knownRedCheck(root, listItems) {
  let items;
  return (file) => {
    items ??= listItems();
    const titles = new Set(oldNames(root, file).map(name => `Main red: ${name}`));
    const owner = items.find(item => [...titles].some(title => item.item_title === title || item.item_title.startsWith(title + ' ')) && !item.item_merged_commit && LIVE.has(item.item_status));
    if (owner) return `known red: open item #${owner.item_id} "${owner.item_title}" owns it, so the candidate result alone is the proof`;
    return null;
  };
}
