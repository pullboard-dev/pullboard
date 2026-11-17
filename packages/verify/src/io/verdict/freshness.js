/** Acceptance stays append-only; freshness is derived from the known Git trunk [E8,V8]. */
import { mergeOnlyLandingProblem } from '../../../../merge/light.js';
import {
  cleanGitEnvironment,
  mainCheckout,
} from '../../../../git/light.js';
import { Refused } from '../../../../kernel/light.js';
import { ownPatchChanges } from '../../logic/verdict/own-patch.js';
import { gitSpawnSync } from '../../../../git/light.js';

/** A freshness failure that carries its own reason text, so each cause names the step the person takes [C7]. */
class FreshnessFailure extends Error {
  /** Keep the reason the stale refusal prints. */
  constructor(reason) { super(reason); this.reason = reason; }
}

/** Read exact Git objects without inherited selectors, replacements, or filename quoting. */
function readGit(root, args, input = undefined) {
  const result = gitSpawnSync(['--no-replace-objects', ...args], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...(input === undefined ? {} : { input }),
  });
  if (result.status !== 0) throw new Error('Git history is unavailable');
  return result.stdout;
}

/**
 * The stable patch id of one path's change between two revisions; empty when the path did not change. The diff carries
 * no context lines: main editing other lines of the same file changes the context around an unchanged hunk, and on
 * 6 Nov that read as a rewrite and sent accepted items back for an identical re-review. The gate still runs the merged
 * tree, so a hunk whose meaning depends on its neighbours is caught there, not here [E8,V8].
 */
function pathPatchId(root, from, to, path) {
  const diff = readGit(root, ['diff', '--no-renames', '--full-index', '--binary', '--unified=0', from, to, '--', path]);
  if (!diff) return '';
  const id = gitSpawnSync(['--no-replace-objects', 'patch-id', '--verbatim'], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', input: diff });
  if (id.status !== 0) throw new Error('Git patch ids are unavailable');
  return id.stdout.split(' ')[0];
}

/** One path's change between two revisions as an unrolled patch with no context lines; empty when the path did not change. */
function pathDiff(root, from, to, path) {
  return readGit(root, ['diff', '--no-renames', '--full-index', '--binary', '--unified=0', from, to, '--', path]);
}

/** The lines of a diff that change a file's mode, existence or binary content, which hunks do not carry. */
const shapeOf = diff => diff.split('\n').filter(line => /^(?:old mode|new mode|new file mode|deleted file mode|GIT binary patch|literal |delta )/u.test(line)).join('\n');

/**
 * Whether one path's reviewed patch and its patch after the merge hold the same hunks, keyed by file and hunk header (#9438).
 * A hunk that only moved to other line numbers is the same hunk. Binary content and mode changes carry no hunks, so they still compare by patch id.
 */
function sameHunks(root, reviewed, merged) {
  if (shapeOf(reviewed) !== shapeOf(merged) || /^GIT binary patch$/mu.test(reviewed)) return null;
  return ownPatchChanges(reviewed, merged).length === 0;
}

/**
 * True when the checked change merges onto main without conflict and every path it touched carries the same
 * patch after the merge as it did against its reviewed trunk [E8,V8,#2896].
 * Why: main touching a shared file (packages/codemap/data/plan/cells.json) said nothing about the reviewed change, yet it made
 * every other accept stale and each needed a re-review of identical work.
 * With verify.hunkFreshness on (#9438) the patches are compared hunk by hunk instead of as one patch id per path, so only
 * a changed hunk of the submit's own patch makes the review stale; the caller reads the setting and passes `hunkKeyed`, so the light read door never loads the config package.
 */
export function composesUnchanged(root, { base, checked, tip, paths }, { hunkKeyed = false } = {}) {
  const merged = gitSpawnSync(['--no-replace-objects', 'merge-tree', '--write-tree', '--no-messages', tip, checked],
    { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8' });
  if (merged.status !== 0) return false;
  const tree = merged.stdout.trim().split('\n')[0];
  return paths.every(path => {
    if (hunkKeyed) {
      const keyed = sameHunks(root, pathDiff(root, base, checked, path), pathDiff(root, tip, tree, path));
      if (keyed !== null) return keyed;
    }
    return pathPatchId(root, base, checked, path) === pathPatchId(root, tip, tree, path);
  });
}

/**
 * True when main already carries the checked bytes on every reviewed path, so landing adds nothing [C7,#2980].
 * Why: #1939's change reached main through #1938; its empty post-merge patch read as a rewrite and stayed stale.
 */
export function mainContains(root, { checked, tip, paths }) {
  return paths.length > 0 && !readGit(root, ['diff', '--no-renames', '--name-only', checked, tip, '--', ...paths]).trim();
}

/** Read the actual retained trunk tip, rather than a cached checkout HEAD used during review. */
export function verdictTrunk(root, { trunkRef }) {
  try {
    const ref = mainCheckout(root)?.branch ?? trunkRef(root);
    if (!ref?.startsWith('refs/heads/')) throw new Error('The retained trunk is unavailable');
    return readGit(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch {
    throw new Refused('BAD_VERDICT_REVIEW', 'the retained trunk cannot be read; restore its branch and Git objects before reviewing');
  }
}

/** Capture the exact checked commit, review trunk and candidate delta against its submitted coordinator snapshot. */
export function captureVerdictReview(root, board, item, trunk = undefined, head = undefined, { events, trunkRef }) {
  if (trunk === undefined) trunk = verdictTrunk(root, { trunkRef });
  if (head === undefined) head = item.item_commit;
  const receipt = events(board, { itemId: item.item_id }).findLast(event => {
    if (event.event_kind !== 'submit') return false;
    return JSON.parse(event.event_detail).commit === item.item_commit;
  });
  const submittedMain = receipt ? JSON.parse(receipt.event_detail).policyCommit : null;
  const base = submittedMain ?? item.item_claim_head;
  if (!base) throw new Refused('BAD_VERDICT_REVIEW', 'the submitted base is unavailable; restore its Git objects before reviewing');
  try {
    const ancestor = readGit(root, ['merge-base', base, item.item_commit]).trim();
    let paths = readGit(root, ['diff', '--no-renames', '--name-only', '-z', ancestor, item.item_commit, '--'])
      .split('\0').filter(Boolean).sort();
    if (head !== item.item_commit) {
      readGit(root, ['merge-base', '--is-ancestor', trunk, head]);
      const repairs = readGit(root, ['diff', '--no-renames', '--name-only', '-z', trunk, head, '--']).split('\0').filter(Boolean);
      paths = [...new Set([...paths, ...repairs])].sort();
    }
    return { commit: item.item_commit, head, trunk, paths };
  } catch {
    throw new Refused('BAD_VERDICT_REVIEW', 'the submitted paths cannot be read; restore the submitted commit and base objects before reviewing');
  }
}

/** Name the concrete stale proof and the required re-review without changing the original verdict. */
export function staleVerdictRefusal(item, state) {
  if (state.landingCode === 'LAND_ITEM_MOVED') return new Refused('STALE_VERDICT',
    `item #${item.item_id}: ${state.reason}; keep its landing receipt and ask the coordinator to create a correction item, then have another agent verify that correction before landing it`);
  const changed = state.file && state.commit
    ? `${JSON.stringify(state.file)} changed on main in ${state.commit}`
    : state.reason ?? 'the reviewed Git history is unavailable';
  return new Refused('STALE_VERDICT', `item #${item.item_id}: ${changed}; merge current main into the submitted commit, commit a clean composition, then another agent runs pullboard verify ${item.item_id} accept --note "what was re-reviewed" before landing`);
}

/** Create one read's projector, sharing Git history lookups across its unlanded acceptances. */
export function verdictProjector(root, board, { main } = {}, { events, acceptedVerdict, verdictReviewProblem, trunkRef, hunkKeyed = false }) {
  let tip = main;
  let resolved = main !== undefined;
  const histories = new Map();
  const validatedBaselines = new Map();
  const changes = new Map();
  const ancestry = new Map();
  const reads = new Map();
  /** One Git read per distinct argument list within this projector; objects are immutable, so a repeat is the same answer [E8]. */
  const readOnce = args => {
    const key = JSON.stringify(args);
    if (!reads.has(key)) reads.set(key, readGit(root, args));
    return reads.get(key);
  };
  let tipAncestors = null;
  /** Every commit reachable from the tip, read by one rev-list for the whole projector [C7]. */
  const reachable = () => tipAncestors ??= new Set(readGit(root, ['rev-list', tip]).split('\n').filter(Boolean));
  const held = new Map();
  /** Ask one cat-file about every commit not yet asked, and remember each answer; a missing or non-commit object is false. */
  const askHeld = commits => {
    const unasked = [...new Set(commits)].filter(commit => typeof commit === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(commit) && !held.has(commit));
    if (!unasked.length) return;
    for (const line of readGit(root, ['cat-file', '--batch-check'], unasked.join('\n') + '\n').split('\n')) {
      const [name, kind] = line.split(' ');
      if (name) held.set(name, kind === 'commit');
    }
  };
  /** Whether Git holds this commit object; commits named to prime() were asked together, any other costs one cat-file. */
  const holdsCommit = commit => { askHeld([commit]); return held.get(commit) === true; };
  /**
   * Git's exit status for 'checked is an ancestor of target', asked once per distinct commit within this projector.
   * Why: one merge-base process per verified item took 23 s of a 50 s first read on a 1,038-item board (fact 833c9dc2),
   * so ancestry of the tip is answered from one rev-list plus a cat-file for the rare commit it does not list [C7].
   */
  const ancestryStatus = (checked, target) => {
    const key = `${checked} ${target}`;
    if (!ancestry.has(key)) {
      const exact = target === tip && /^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(`${checked}`) && /^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(`${tip}`);
      if (exact) ancestry.set(key, reachable().has(checked) ? 0 : holdsCommit(checked) ? 1 : 128);
      else ancestry.set(key, gitSpawnSync(['--no-replace-objects', 'merge-base', '--is-ancestor', checked, target],
        { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8' }).status);
    }
    return ancestry.get(key);
  };
  /** Query only first-parent commits touching these literal paths, retaining merges and reverts. */
  const history = (baseline, paths) => {
    // A reviewed trunk that left main (a rebased or rewritten branch) is judged from merge-base(trunk, main).
    if (!validatedBaselines.has(baseline)) {
      const onMain = ancestryStatus(baseline, tip);
      if (onMain === 0) validatedBaselines.set(baseline, baseline);
      else if (onMain === 1) {
        let shared = '';
        try { shared = readGit(root, ['merge-base', baseline, tip]).trim(); } catch { /* reported below */ }
        if (!shared) throw new FreshnessFailure(`the reviewed trunk ${baseline.slice(0, 12)} is not on main and shares no history with it; merge current main and re-review`);
        validatedBaselines.set(baseline, shared);
      } else throw new FreshnessFailure(`the reviewed trunk ${baseline.slice(0, 12)} is missing from this replica; fetch its objects or re-review`);
    }
    baseline = validatedBaselines.get(baseline);
    const key = JSON.stringify([baseline, [...paths]]);
    if (!histories.has(key)) {
      const commits = paths.size ? readGit(root, ['--literal-pathspecs', 'log', '--first-parent', '--full-history',
        '--diff-merges=first-parent', '--no-renames', '--reverse', '--format=%H', `${baseline}..${tip}`, '--', ...paths])
        .trim().split('\n').filter(Boolean) : [];
      histories.set(key, commits);
    }
    return histories.get(key);
  };
  /** Compare every commit with its first parent, so a merge's files and a revert both count. */
  const changedFiles = commit => {
    if (!changes.has(commit)) changes.set(commit,
      readGit(root, ['diff', '--no-renames', '--name-only', '-z', `${commit}^1`, commit, '--']).split('\0').filter(Boolean));
    return changes.get(commit);
  };
  /** Derive pending proof freshness and an older landing's explicitly recorded review mismatch. */
  const state = item => {
    if (item.item_status !== 'verified') return null;
    if (item.item_rehome_import?.sourceStatus === 'verified') return null;
    const accepted = acceptedVerdict(board, item);
    const carryProblem = !item.item_merged_commit && mergeOnlyLandingProblem(root, board, item, { acceptedVerdict: acceptedVerdict });
    if (carryProblem) return { code: 'STALE_VERDICT', reason: carryProblem.message, main: tip ?? null };
    const mismatch = item.item_merged_commit && events(board, { itemId: item.item_id }).findLast(event => {
      if (event.event_kind !== 'landing-review-moved') return false;
      const detail = JSON.parse(event.event_detail);
      return detail.verdict === accepted?.verdict_id && detail.landed === item.item_merged_commit;
    });
    if (item.item_merged_commit && !mismatch) return null;
    let review = accepted?.review;
    try {
      if (!resolved) {
        resolved = true;
        tip = verdictTrunk(root, { trunkRef });
      }
      if (!tip) throw new FreshnessFailure('the known trunk is unavailable; restore the trunk branch and re-review');
      review = accepted?.review;
      if (review && verdictReviewProblem(review, item.item_commit)) throw new FreshnessFailure('the sealed review does not match the submitted commit; re-review the clean composition');
      const checked = review?.head ?? item.item_commit;
      // A physical landing is final only when it includes the checked composition.
      const landed = ancestryStatus(checked, tip);
      if (landed === 0) return null;
      if (landed !== 1) throw new FreshnessFailure(`the checked commit ${checked.slice(0, 12)} is missing from this replica; fetch it or re-review`);
      if (mismatch) return { code: 'STALE_VERDICT', file: null, commit: item.item_merged_commit,
        reviewedTrunk: review.trunk, main: tip, landingCode: 'LAND_ITEM_MOVED', checked: review.head,
        reason: `the older landing recorded ${item.item_merged_commit}, which does not contain checked composition ${review.head}` };
      if (review && !review.head) return { code: 'STALE_VERDICT', file: null, commit: null,
        reviewedTrunk: review.trunk, main: tip, reason: 'this acceptance predates checked-commit binding; re-review the clean composition with current Pullboard' };
      if (review?.head && review.head !== item.item_commit) {
        readGit(root, ['merge-base', '--is-ancestor', item.item_commit, review.head]);
        readGit(root, ['merge-base', '--is-ancestor', review.trunk, review.head]);
      }
      if (!review) {
        // Legacy receipts did not seal a reviewed trunk. Use a conservative claim-base bound,
        // never invent a capture time or rewrite those immutable receipts.
        const baseline = readOnce(['merge-base', item.item_claim_head, tip]).trim();
        // A claim base that is the trunk tip has no commits after it, so no path can have changed: skip the diff.
        if (baseline === tip) return null;
        review = { trunk: baseline,
          paths: readOnce(['diff', '--no-renames', '--name-only', '-z', baseline, item.item_commit, '--']).split('\0').filter(Boolean), legacy: true };
      }
      if (!review.legacy && verdictReviewProblem(review, item.item_commit)) throw new FreshnessFailure('the sealed review does not match the submitted commit; re-review the clean composition');
      const paths = new Set(review.paths);
      for (const commit of history(review.trunk, paths)) {
        const file = changedFiles(commit).find(path => paths.has(path));
        if (file && mainContains(root, { checked, tip, paths: [...paths] })) return null;
        if (file && !review.legacy && composesUnchanged(root, { base: review.trunk, checked, tip, paths: [...paths] }, { hunkKeyed })) return null;
        if (file) return { code: 'STALE_VERDICT', file, commit, reviewedTrunk: review.trunk, main: tip,
          ...(review.legacy ? { legacy: true } : {}) };
      }
      return null;
    } catch (failure) {
      return { code: 'STALE_VERDICT', file: null, commit: null, reviewedTrunk: review?.trunk ?? null,
        main: tip ?? null, ...(mismatch ? { landingCode: 'LAND_ITEM_MOVED', checked: review?.head,
          reason: `the older landing recorded ${item.item_merged_commit}; checked composition ${review?.head} is unavailable on this replica` }
          : { reason: failure?.reason ?? 'the reviewed Git history is unavailable; restore its objects and re-review' }) };
    }
  };
  /** Decorate a public item read while preserving every stored proof field. */
  const project = item => {
    const freshness = state(item);
    return freshness ? { ...item, item_verdict_state: freshness } : item;
  };
  /** Ask Git about every unlanded verified item's commit in one process, before the per-item reads need them [C7]. */
  const prime = items => askHeld(items.filter(item => item.item_status === 'verified' && !item.item_merged_commit).map(item => item.item_commit));
  return { state, project, prime, main: tip ?? null };
}


const PRESENTATION_VERDICTS = new Map();

/** Reuse derived presentation values, never a closed board connection or mutable native row. */
export function cachedVerdictStates(root, board, info, { events, acceptedVerdict, verdictReviewProblem, boardId, trunkRevisionReader, hunkKeyed = false }) {
  // The caller's reader keeps the trunk watcher out of this light module; an unknown tip lets the projector resolve the trunk itself.
  const tip = trunkRevisionReader(info)();
  const event = board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id;
  const key = JSON.stringify([info.commonDir, boardId(board)]);
  const revision = JSON.stringify([tip, event, hunkKeyed]);
  let cached = PRESENTATION_VERDICTS.get(key);
  if (cached?.revision !== revision) {
    cached = { revision, states: new Map() };
    PRESENTATION_VERDICTS.delete(key);
    PRESENTATION_VERDICTS.set(key, cached);
    while (PRESENTATION_VERDICTS.size > 32) PRESENTATION_VERDICTS.delete(PRESENTATION_VERDICTS.keys().next().value);
  }
  const projector = verdictProjector(root, board, { main: tip ?? undefined }, { events, acceptedVerdict, verdictReviewProblem, hunkKeyed });
  /** Refresh only a changed item; unchanged sealed presentations start no new Git process. */
  return item => {
    const raw = JSON.stringify(item);
    const prior = cached.states.get(item.item_id);
    if (prior?.raw === raw) return prior.state;
    const state = projector.state(item);
    // A fetched review pin can resolve missing objects without changing this revision.
    if (!state?.reason) cached.states.set(item.item_id, { raw, state });
    return state;
  };
}
