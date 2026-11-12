/** Exact failure-to-repair links, checked before submission and again by the ordered board move [V4,B3]. */
import { literalShellWords } from "../../../../../kernel/light.js";
import { Refused } from "../../../../../kernel/light.js";

/** A repair is still open until its accepted source lands; a broad spec-row match grants nothing. */
function covers(item, file, exclude) {
  if (item.item_id === exclude || !['open', 'claimed', 'submitted', 'verified'].includes(item.item_status)
    || item.item_merged_commit || !/^(?:main red|red cluster)\s*:/iu.test(item.item_title)) return false;
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
export function ownersOf(failure, items, exclude, modern = true, runningFile = false) {
  const paths = new Set([failure.file, ...(runningFile && failure.ran ? [failure.ran] : [])]);
  const named = items.filter(item => [...paths].some(file => covers(item, file, exclude)));
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
export function linkKnownMainReworks(known, items, exclude, modern = true, runningFile = false) {
  if (!known) return null;
  const failures = [];
  for (const failure of known.failures) {
    const owners = ownersOf(failure, items, exclude, modern, runningFile);
    if (owners.length !== 1) return null;
    failures.push({ ...failure, item: owners[0].item_id });
  }
  return { ...known, failures };
}

/** Recheck sealed links against the board state at the ordered move, including receiver replay. */
export function requireKnownMainReworks(known, items, exclude, modern = true, runningFile = false) {
  if (!known) return;
  const linked = linkKnownMainReworks(known, items, exclude, modern, runningFile);
  if (!linked || linked.failures.some((row, index) => row.item !== known.failures[index].item)) {
    throw new Refused('SUBMISSION_PROOF', 'each known main failure needs its unique still-open Main red repair naming the exact test file, or its exact case when several name the file; file or repair the item, then submit again');
  }
}

/** Failures lacking an owner, grouped by file; null when any failure is already ambiguous, so filing never adds a second owner (#1917). */
export function unownedMainReds(known, items, exclude, runningFile = false) {
  const missing = new Map();
  for (const failure of known.failures) {
    const owners = ownersOf(failure, items, exclude, true, runningFile);
    if (owners.length > 1) return null;
    if (!owners.length) missing.set(failure.file, [...(missing.get(failure.file) ?? []), failure.name]);
  }
  return [...missing].map(([file, names]) => ({ file, names }));
}

/** Failures with several candidate owners and no single one naming the case, each with its candidates, for the refusal (#2016). */
export function ambiguousMainReds(known, items, exclude, runningFile = false) {
  return known.failures.map(failure => ({ file: failure.file, name: failure.name, candidates: ownersOf(failure, items, exclude, true, runningFile).map(item => item.item_id).sort((a, b) => a - b) }))
    .filter(row => row.candidates.length > 1);
}

/**
 * Split exact known main failures into those with at most one owning repair and those with several candidate owners.
 * A case red on both main and the item is known-main whoever owns it; only the proof's owner link needs a single repair,
 * so the ambiguous cases are reported by name and never fail the gate (#2528).
 */
export function splitAmbiguousMainReds(known, items, exclude, runningFile = false) {
  const ambiguous = ambiguousMainReds(known, items, exclude, runningFile);
  const clear = { ...known, failures: known.failures.filter(failure => !ambiguous.some(row => row.file === failure.file && row.name === failure.name)) };
  return { clear, ambiguous };
}

/**
 * Whether a recorded check baseline names, by file and case, the cases its check fails at exactly this main commit. A
 * baseline that names failing cases without their files cannot tell the same name in two files apart, so it is re-taken.
 */
function namesCasesAt(baseline, main) {
  return baseline?.main === main && (baseline.result === 'green'
    || baseline.result === 'red' && Array.isArray(baseline.testEvidence?.failedCases) && baseline.testEvidence.failedCases.length > 0);
}

/**
 * Open Main red repairs whose check names one of the files and whose recorded check baseline cannot say which cases
 * fail on this main: none recorded, taken on another main, or red with no case names (#2594). Each is re-taken first.
 */
export function mainRedBaselinesToRetake(items, files, exclude, main) {
  return items.filter(item => files.some(file => covers(item, file, exclude)) && !namesCasesAt(item.item_check_baseline, main));
}

/**
 * Split failures into those an open Main red repair's check fails on this main, by its current baseline, and the rest.
 * A case such a repair already fails on main is known main and never fails another item's check (#2594).
 *
 * @param {{ file: string, name: string }[]} failures
 * @param {object[]} items
 * @param {number} exclude
 * @param {string} main
 * @param {Map<number, object>} [baselines] - Baselines re-taken on this main, by item id; they replace the recorded ones.
 */
export function mainRedItemCases(failures, items, exclude, main, baselines = new Map()) {
  const owned = [], rest = [];
  for (const failure of failures) {
    const titles = [failure.name, failure.name.replace(/\s*\[[^\]]*\]\s*$/u, '')];
    const owner = items.filter(item => covers(item, failure.file, exclude)).find(item => {
      const baseline = baselines.get(item.item_id) ?? item.item_check_baseline;
      // A case is the same case only in the same file: X in A failing on main says nothing about X in B (#2594).
      return namesCasesAt(baseline, main) && baseline.result === 'red'
        && baseline.testEvidence.failedCases.some(row => row.file === failure.file
          && (titles.includes(row.name) || titles.includes(row.name.replace(/\s*\[[^\]]*\]\s*$/u, ''))));
    });
    if (owner) owned.push({ ...failure, item: owner.item_id });
    else rest.push(failure);
  }
  return { owned, rest };
}
