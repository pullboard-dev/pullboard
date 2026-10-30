/** Exact failure-to-repair links, checked before submission and again by the ordered board move [V4,B3]. */
import { literalShellWords } from './literal-shell-words.js';
import { Refused } from './refused.js';

/** A repair is still open until its accepted source lands; a broad spec-row match grants nothing. */
function covers(item, files, exclude) {
  if (item.item_id === exclude || !['open', 'claimed', 'submitted', 'verified'].includes(item.item_status)
    || item.item_merged_commit || !/^main red\s*:/iu.test(item.item_title)) return false;
  let check = item.item_check;
  if (item.item_frozen) {
    try { check = JSON.parse(item.item_frozen).check ?? ''; }
    catch { return false; }
  }
  return (literalShellWords(check) ?? []).some(word => files.includes(word.replace(/^\.\//u, '')));
}

/** The criterion a repair was frozen with, or its current one before any claim. */
function criterionOf(item) {
  if (item.item_frozen) {
    try { return String(JSON.parse(item.item_frozen).criterion ?? item.item_criterion ?? ''); }
    catch { return ''; }
  }
  return String(item.item_criterion ?? '');
}

/** Read literal case selectors from the frozen command; malformed selectors never claim a case. */
function selects(item, name) {
  let check = item.item_check;
  try { if (item.item_frozen) check = JSON.parse(item.item_frozen).check ?? ''; } catch { return { matches: false, whole: false }; }
  const words = literalShellWords(check);
  if (!words) return { matches: false, whole: false };
  const include = [], skip = [];
  try {
    for (let i = 0; i < words.length; i++) {
      const match = /^(--test-(?:name|skip)-pattern)(?:=(.*))?$/u.exec(words[i]);
      if (!match) continue;
      const value = match[2] ?? words[++i];
      if (value === undefined || value.startsWith('--')) return { matches: false, whole: false };
      (match[1] === '--test-name-pattern' ? include : skip).push(new RegExp(value));
    }
  } catch { return { matches: false, whole: false }; }
  return { matches: (!include.length || include.some(pattern => pattern.test(name))) && !skip.some(pattern => pattern.test(name)),
    whole: !include.length && !skip.length };
}

/**
 * The open repairs that own one exact failure. One repair naming the file owns it; when several name the file, only
 * those whose criterion names the exact case title (with or without its trailing spec ids) own it, so a test file
 * shared by several Main red items stays matchable case by case (#2016). Anything but one result is no single owner.
 */
export function ownersOf(failure, items, exclude, modern = true) {
  // A case defined in a helper is owned by a repair naming the helper or the test file that runs it (#2064).
  const named = items.filter(item => covers(item, [failure.file, failure.ran].filter(Boolean), exclude));
  const titles = [failure.name, failure.name.replace(/\s*\[[^\]]*\]\s*$/u, '')].filter(Boolean);
  if (!modern) {
    if (named.length <= 1) return named;
    const byCase = named.filter(item => titles.some(title => criterionOf(item).includes(title)));
    return byCase.length === 1 ? byCase : named;
  }
  const eligible = named.map(item => ({ item, selection: selects(item, failure.name) })).filter(row => row.selection.matches);
  const byCase = eligible.filter(({ item }) => titles.some(title => criterionOf(item).includes(title)));
  if (byCase.length) return byCase.map(row => row.item);
  const whole = eligible.filter(row => row.selection.whole);
  return (whole.length ? whole : eligible).map(row => row.item);
}

/** Every exact known failure needs precisely one still-open repair naming its test file, or its case when the file is shared. */
export function linkKnownMainReworks(known, items, exclude, modern = true) {
  if (!known) return null;
  const failures = [];
  for (const failure of known.failures) {
    const owners = ownersOf(failure, items, exclude, modern);
    if (owners.length !== 1) return null;
    failures.push({ ...failure, item: owners[0].item_id });
  }
  return { ...known, failures };
}

/** Recheck sealed links against the board state at the ordered move, including receiver replay. */
export function requireKnownMainReworks(known, items, exclude, modern = true) {
  if (!known) return;
  const linked = linkKnownMainReworks(known, items, exclude, modern);
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
  return known.failures.map(failure => ({ file: failure.file, name: failure.name, candidates: ownersOf(failure, items, exclude).map(item => item.item_id).sort((a, b) => a - b) }))
    .filter(row => row.candidates.length > 1);
}
