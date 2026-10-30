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

/** The criterion a repair was frozen with, or its current one before any claim. */
function criterionOf(item) {
  if (item.item_frozen) {
    try { return String(JSON.parse(item.item_frozen).criterion ?? item.item_criterion ?? ''); }
    catch { return ''; }
  }
  return String(item.item_criterion ?? '');
}

/**
 * The open repairs that own one exact failure. One repair naming the file owns it; when several name the file, only
 * those whose criterion names the exact case title (with or without its trailing spec ids) own it, so a test file
 * shared by several Main red items stays matchable case by case (#2016). Anything but one result is no single owner.
 */
export function ownersOf(failure, items, exclude) {
  const named = items.filter(item => covers(item, failure.file, exclude));
  if (named.length <= 1) return named;
  const titles = [failure.name, failure.name.replace(/\s*\[[^\]]*\]\s*$/u, '')].filter(Boolean);
  const byCase = named.filter(item => titles.some(title => criterionOf(item).includes(title)));
  return byCase.length === 1 ? byCase : named;
}

/** Every exact known failure needs precisely one still-open repair naming its test file, or its case when the file is shared. */
export function linkKnownMainReworks(known, items, exclude) {
  if (!known) return null;
  const failures = [];
  for (const failure of known.failures) {
    const owners = ownersOf(failure, items, exclude);
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
    throw new Refused('SUBMISSION_PROOF', 'each known main failure needs its unique still-open Main red repair naming the exact test file, or its exact case when several name the file; file or repair the item, then submit again');
  }
}

/** Failures lacking an owner, grouped by file; null when any failure is already ambiguous, so filing never adds a second owner (#1917). */
export function unownedMainReds(known, items, exclude) {
  const missing = new Map();
  for (const failure of known.failures) {
    const owners = ownersOf(failure, items, exclude);
    if (owners.length > 1) return null;
    if (!owners.length) missing.set(failure.file, [...(missing.get(failure.file) ?? []), failure.name]);
  }
  return [...missing].map(([file, names]) => ({ file, names }));
}

/** Failures with several candidate owners and no single one naming the case, each with its candidates, for the refusal (#2016). */
export function ambiguousMainReds(known, items, exclude) {
  return known.failures.map(failure => ({ file: failure.file, name: failure.name, candidates: ownersOf(failure, items, exclude).map(item => item.item_id) }))
    .filter(row => row.candidates.length > 1);
}
