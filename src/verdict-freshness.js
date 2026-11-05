/** Acceptance stays append-only; freshness is derived from the known Git trunk [E8,V8]. */
import { mergeOnlyLandingProblem } from './merge-only-verdict.js';
import { spawnSync } from './windows-child-process.js';
import * as store from './board-query.js';
import {
  cleanGitEnvironment,
  mainCheckout,
} from './git.js';
import { trunkRef } from './trusted-policy-read.js';
import { Refused } from './refused.js';
import { trunkRevisionReader } from './trunk-revision.js';

/** Read exact Git objects without inherited selectors, replacements, or filename quoting. */
function readGit(root, args) {
  const result = spawnSync('git', ['--no-replace-objects', ...args], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('Git history is unavailable');
  return result.stdout;
}

/** Read the actual retained trunk tip, rather than a cached checkout HEAD used during review. */
export function verdictTrunk(root) {
  try {
    const ref = mainCheckout(root)?.branch ?? trunkRef(root);
    if (!ref?.startsWith('refs/heads/')) throw new Error('The retained trunk is unavailable');
    return readGit(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch {
    throw new Refused('BAD_VERDICT_REVIEW', 'the retained trunk cannot be read; restore its branch and Git objects before reviewing');
  }
}

/** Capture the exact checked commit, review trunk and candidate delta against its submitted coordinator snapshot. */
export function captureVerdictReview(root, board, item, trunk = verdictTrunk(root), head = item.item_commit) {
  const receipt = store.events(board, { itemId: item.item_id }).findLast(event => {
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
export function verdictProjector(root, board, { main } = {}) {
  let tip = main;
  let resolved = main !== undefined;
  const histories = new Map();
  const validatedBaselines = new Set();
  const changes = new Map();
  /** Query only first-parent commits touching these literal paths, retaining merges and reverts. */
  const history = (baseline, paths) => {
    if (!validatedBaselines.has(baseline)) {
      readGit(root, ['merge-base', '--is-ancestor', baseline, tip]);
      validatedBaselines.add(baseline);
    }
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
    const accepted = store.acceptedVerdict(board, item);
    const carryProblem = !item.item_merged_commit && mergeOnlyLandingProblem(root, board, item);
    if (carryProblem) return { code: 'STALE_VERDICT', reason: carryProblem.message, main: tip ?? null };
    const mismatch = item.item_merged_commit && store.events(board, { itemId: item.item_id }).findLast(event => {
      if (event.event_kind !== 'landing-review-moved') return false;
      const detail = JSON.parse(event.event_detail);
      return detail.verdict === accepted?.verdict_id && detail.landed === item.item_merged_commit;
    });
    if (item.item_merged_commit && !mismatch) return null;
    let review = accepted?.review;
    try {
      if (!resolved) {
        resolved = true;
        tip = verdictTrunk(root);
      }
      if (!tip) throw new Error('The known trunk is unavailable');
      review = accepted?.review;
      if (review && store.verdictReviewProblem(review, item.item_commit)) throw new Error('The sealed review is invalid');
      const checked = review?.head ?? item.item_commit;
      // A physical landing is final only when it includes the checked composition.
      const landed = spawnSync('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', checked, tip],
        { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8' });
      if (landed.status === 0) return null;
      if (landed.status !== 1) throw new Error('The checked commit is unavailable');
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
        const baseline = readGit(root, ['merge-base', item.item_claim_head, tip]).trim();
        review = { trunk: baseline,
          paths: readGit(root, ['diff', '--no-renames', '--name-only', '-z', baseline, item.item_commit, '--']).split('\0').filter(Boolean), legacy: true };
      }
      if (!review.legacy && store.verdictReviewProblem(review, item.item_commit)) throw new Error('The sealed review is invalid');
      const paths = new Set(review.paths);
      for (const commit of history(review.trunk, paths)) {
        const file = changedFiles(commit).find(path => paths.has(path));
        if (file) return { code: 'STALE_VERDICT', file, commit, reviewedTrunk: review.trunk, main: tip,
          ...(review.legacy ? { legacy: true } : {}) };
      }
      return null;
    } catch {
      return { code: 'STALE_VERDICT', file: null, commit: null, reviewedTrunk: review?.trunk ?? null,
        main: tip ?? null, ...(mismatch ? { landingCode: 'LAND_ITEM_MOVED', checked: review?.head,
          reason: `the older landing recorded ${item.item_merged_commit}; checked composition ${review?.head} is unavailable on this replica` }
          : { reason: 'the reviewed Git history is unavailable; restore its objects and re-review' }) };
    }
  };
  /** Decorate a public item read while preserving every stored proof field. */
  const project = item => {
    const freshness = state(item);
    return freshness ? { ...item, item_verdict_state: freshness } : item;
  };
  return { state, project, main: tip ?? null };
}


const PRESENTATION_VERDICTS = new Map();

/** Reuse derived presentation values, never a closed board connection or mutable native row. */
export function cachedVerdictStates(root, board, info) {
  const tip = trunkRevisionReader(info)();
  const event = board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id;
  const key = JSON.stringify([info.commonDir, store.boardId(board)]);
  const revision = JSON.stringify([tip, event]);
  let cached = PRESENTATION_VERDICTS.get(key);
  if (cached?.revision !== revision) {
    cached = { revision, states: new Map() };
    PRESENTATION_VERDICTS.delete(key);
    PRESENTATION_VERDICTS.set(key, cached);
    while (PRESENTATION_VERDICTS.size > 32) PRESENTATION_VERDICTS.delete(PRESENTATION_VERDICTS.keys().next().value);
  }
  const projector = verdictProjector(root, board, { main: tip });
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
