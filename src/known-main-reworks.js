/** Exact failure-to-repair links, checked before submission and again by the ordered board move [V4,B3]. */
import { literalShellWords } from './literal-shell-words.js';
import { Refused } from './refused.js';

/** A repair is still open until its accepted source lands; a broad spec-row match grants nothing. */
function covers(item, file, exclude) {
  if (item.item_id === exclude || !['open', 'claimed', 'submitted', 'verified'].includes(item.item_status)
    || item.item_merged_commit || !/^main red\s*:/iu.test(item.item_title)) return false;
  let check = item.item_check;
  if (item.item_frozen) {
    try { check = JSON.parse(item.item_frozen).check ?? ''; }
    catch { return false; }
  }
  return (literalShellWords(check) ?? []).some(word => word.replace(/^\.\//u, '') === file);
}

/** Every exact known failure needs precisely one still-open repair naming its literal test file. */
export function linkKnownMainReworks(known, items, exclude) {
  if (!known) return null;
  const failures = [];
  for (const failure of known.failures) {
    const owners = items.filter(item => covers(item, failure.file, exclude));
    if (owners.length !== 1) return null;
    failures.push({ ...failure, item: owners[0].item_id });
  }
  return { ...known, failures };
}

/** Recheck sealed links against the board state at the ordered move, including receiver replay. */
export function requireKnownMainReworks(known, items, exclude) {
  if (!known) return;
  const linked = linkKnownMainReworks(known, items, exclude);
  if (!linked || linked.failures.some((row, index) => row.item !== known.failures[index].item)) {
    throw new Refused('SUBMISSION_PROOF', 'each known main failure needs its unique still-open Main red repair naming the exact test file; file or repair the item, then submit again');
  }
}
