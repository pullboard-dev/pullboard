import { requireLandingCompanions } from '../guards.js';
import { requireLandingModuleResolution } from '../guards.js';
import { requireLandingSecretFree } from '../guards.js';
import { requireRecordedMoves } from '../guards.js';
import { repointLandingGates } from '../../../../spec/index.js';
/** Coordinator landing merge step; source-preserving partition of land.js [B3,R3,C7]. */
import { resolveMechanicalIndex } from '../../../../merge/index.js';
import * as store from '../../../../store/index.js';
import { git } from '../../../../git/index.js';
import { headCommit } from '../../../../git/index.js';
import { isClean } from '../../../../git/index.js';
import { tryGit } from '../../../../git/index.js';
import { untracked } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';
import { hunkFreshnessEnabled } from '../../../../config/index.js';
import { landingSquashEnabled } from '../../../../config/index.js';
import { squashOnto } from '../land/squash.js';
import { checkLandingMessages } from '../../logic/message.js';
import { landingContext } from '../../logic/message.js';
import { tightenLandingDoctrine } from '../doctrine.js';
import { scanRidesRunner } from '../scan.js';
import { amendLandingEngines } from '../derive.js';
import { firstContainingCommit } from '../first.js';
import { composeOnRunner } from './compose.js';
import { deriveOnRunner } from './derive.js';
import { commitDerived } from './derive.js';
import { deriveRidesRunner } from './derive.js';
import { staleVerdictRefusal } from '../../../../verify/index.js';
import { verdictProjector } from '../../../../verify/index.js';
import { landingHooks } from './selection.js';

/** Append a durable snapshot before or after each external side effect. */
export async function save(state, patch) {
  const conflicts = [...new Map([...(state.batch.conflicts ?? []), ...(patch.conflicts ?? [])].map((entry) => [entry.id, entry])).values()];
  const resolutions = [...new Map([...(state.batch.resolutions ?? []), ...(patch.resolutions ?? [])]
    .map(entry => [JSON.stringify(entry), entry])).values()];
  state.batch = await state.write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...state.batch, ...patch, conflicts, resolutions }, revision: state.batch.revision ?? 0 }]);
  return state.batch;
}

/**
 * A batch's own worktree left dirty by its staged steps (engine numbers, docs) is reset to the batch base once and
 * merged again; dirty a second time, the batch stops as blocked with its refusal recorded. Why: the dirty refusal used
 * to leave the batch adoptable, so every automatic wake retried it and refused again every few seconds (#2624).
 */
async function resetDirtyOnce(state) {
  if (!state.batch.dirtyReset) {
    git(state.batch.root, ['reset', '--hard', '--quiet', state.batch.base]);
    git(state.batch.root, ['clean', '-fdq']);
    await save(state, { dirtyReset: true });
    if (isClean(state.batch.root) && !untracked(state.batch.root).length) return;
  }
  await save(state, { state: 'blocked', refusal: { code: 'LAND_DIRTY', message: 'the landing worktree has uncommitted changes', at: state.board.clock.now().toISOString() } });
  throw new Refused('LAND_DIRTY', `landing batch ${state.batch.id} left its worktree dirty again after one reset; it is blocked and will not retry; inspect ${state.batch.root}`);
}

/**
 * The verdict projector for one batch base, shared by every merge group of the batch.
 * Why: its Git answers (ancestry, first-parent history, changed files) are fixed by the immutable base, so a bisection's
 * ten merge groups asked Git the same questions for every item again; item state is still read from the board each time [C7].
 */
function baseVerdicts(state, base) {
  state.baseVerdicts ??= new Map();
  if (!state.baseVerdicts.has(base)) state.baseVerdicts.set(base, verdictProjector(state.root, state.board, { main: base },
    { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, hunkKeyed: hunkFreshnessEnabled() }));
  return state.baseVerdicts.get(base);
}

/** Merge one ordered group from the immutable batch base, preserving each first-containing commit. */
export async function mergeGroup(state, items) {
  await state.checkLease();
  const { batch } = state;
  if (!isClean(batch.root) || untracked(batch.root).length) await resetDirtyOnce(state);
  git(state.batch.root, ['checkout', '--detach', state.batch.base]);
  // Every message is built and checked before the first merge, so a bad one cannot land half a batch.
  // A named landing carries the coordinator's proven commits; those are the commits it merges and checks [C7,#5559].
  const proven = batch.external ? new Map((batch.candidates ?? batch.items).map(entry => [entry.id, entry.commit])) : null;
  const landedCommit = (item) => proven?.get(item.item_id) ?? store.checkedLandingCommit(state.board, item);
  const messages = checkLandingMessages(items.map((entry) => store.getItem(state.board, entry.id ?? entry.item_id)),
    landingContext(batch.root, batch.base, state.config, landedCommit));
  const merged = [];
  const conflicts = [];
  const resolutions = [];
  // A per-item landing merges the reviewed commit with repository hooks off: they ran when the item was built [C7,#2901].
  const hooks = landingHooks(state.config);
  // With landing.squash on, an item lands as one single-parent commit and its branch stays under refs/pullboard/items/<id> [C7,#9220].
  const squash = landingSquashEnabled();
  const onRunner = deriveRidesRunner(state);
  // A named batch's merges, gate repoints and derived files are built by one runner job; this checkout only takes its commit [C7,#5585].
  const composed = onRunner && items.length ? await composeOnRunner(state, items.map(entry => {
    const item = store.getItem(state.board, entry.id ?? entry.item_id);
    const message = messages.get(item.item_id);
    return { id: item.item_id, commit: landedCommit(item), header: message.header, trailers: message.trailers };
  })) : null;
  if (onRunner && !composed) state.say('the runner could not compose this batch; its items were merged on the coordinator');
  if (composed) {
    for (const engine of composed.assigned) state.say(`engine ${engine.name}: ${engine.number}`);
    for (const entry of composed.renames) {
      resolutions.push({ id: entry.id, files: [state.config.spec], entries: entry.changes.map(change => ({ kind: 'spec-gate-rename', ...change })) });
      for (const change of entry.changes) state.say(`spec ${change.row}: gate ${change.from} -> ${change.to}`);
    }
  }
  for (const entry of items) {
    await state.checkLease();
    const item = store.getItem(state.board, entry.id ?? entry.item_id);
    if (!proven && (item.item_status !== 'verified' || item.item_commit !== (entry.commit ?? item.item_commit))) throw new Refused('LAND_ITEM_MOVED', `item #${item.item_id} changed; rebuild the batch from current verified work`);
    if (proven && item.item_merged_commit) throw new Refused('LAND_ITEM_MOVED', `item #${item.item_id} is already merged; name only unmerged items`);
    const checked = landedCommit(item);
    if (!proven && checked !== (entry.reviewedCommit ?? entry.commit ?? item.item_commit)) throw new Refused('LAND_ITEM_MOVED', `item #${item.item_id} was re-reviewed; rebuild its landing from the checked commit`);
    requireLandingCompanions(batch.root, state.board, [item], checked);
    requireRecordedMoves(batch.root, headCommit(batch.root), checked);
    const stale = proven ? null : baseVerdicts(state, batch.base).state(item);
    if (stale) throw staleVerdictRefusal(item, stale);
    if (composed) {
      merged.push({ id: item.item_id, commit: proven ? checked : item.item_commit, ...(checked !== (proven ? checked : item.item_commit) ? { reviewedCommit: checked } : {}), merge: composed.merges.get(item.item_id) });
      continue;
    }
    // The body is the trailer paragraph alone: the header carries the title, and no lane branch is named [B3,R3].
    // merge.log is switched off on this call, so a local Git config cannot append a shortlog to the body.
    const trunk = headCommit(batch.root);
    const message = messages.get(item.item_id);
    // A squash that conflicts writes nothing, so the merge below runs as with the setting off and keeps its mechanical resolution.
    const squashed = squash ? squashOnto(batch.root, { base: trunk, tip: checked, message: `${message.header}\n\n${message.trailers}`, item: item.item_id }) : null;
    if (squashed?.commit) git(batch.root, ['reset', '-q', '--hard', squashed.commit]);
    const result = squashed?.commit ? { status: 0 } : tryGit(batch.root, [...hooks, '-c', 'merge.log=false', 'merge', '--no-ff', '--no-log', checked, '-m', message.header, '-m', message.trailers]);
    if (result.status !== 0) {
      const files = tryGit(batch.root, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
      if (!files.length) throw new Refused('LAND_MERGE', `merge of #${item.item_id} failed outside a conflict: ${result.stderr || result.stdout}; inspect ${batch.root} and its hooks before adopting`);
      const resolution = resolveMechanicalIndex(batch.root, files);
      if (resolution.failed) {
        git(batch.root, ['merge', '--abort']);
        throw new Refused('LAND_MERGE', `item #${item.item_id}: generator ${resolution.failed.generator} failed for ${resolution.failed.path} (exit ${resolution.failed.status ?? 'unavailable'}); repair the generator before adopting this landing`);
      }
      if (!resolution.files.length) {
        git(batch.root, ['add', '--', ...files]);
        // The message is written again, so Git's conflict notes can never follow the trailers.
        git(batch.root, [...hooks, 'commit', '-m', message.header, '-m', message.trailers]);
        resolutions.push({ id: item.item_id, files, entries: resolution.entries });
        state.say(`mechanical merge #${item.item_id}: ${files.join(', ')}`);
      } else {
        git(batch.root, ['merge', '--abort']);
        conflicts.push({ id: item.item_id, files: resolution.files, trunk, commit: item.item_commit, reviewedCommit: checked });
        state.say(`conflict #${item.item_id}: ${resolution.files.join(', ')}`);
        continue;
      }
    }
    const gateRenames = repointLandingGates(batch.root, state.config, trunk, headCommit(batch.root));
    if (gateRenames.length) {
      git(batch.root, ['add', '--', state.config.spec]);
      git(batch.root, [...hooks, 'commit', '--amend', '--no-edit']);
      resolutions.push({ id: item.item_id, files: [state.config.spec], entries: gateRenames.map(change => ({ kind: 'spec-gate-rename', ...change })) });
      for (const change of gateRenames) state.say(`spec ${change.row}: gate ${change.from} -> ${change.to}`);
    }
    // An engine the item added without a number gets the next one now, in landing order, inside its own merge (#1101).
    // A named batch derives once after its last merge, on a runner (below), so the coordinator spends no CPU on it [C7,#5568].
    if (!onRunner) for (const engine of amendLandingEngines(batch.root, hooks).assigned) state.say(`engine ${engine.name}: ${engine.number} for #${item.item_id}`);
    const first = squashed?.commit ? headCommit(batch.root) : firstContainingCommit(batch.root, checked);
    const commit = proven ? checked : item.item_commit;
    merged.push({ id: item.item_id, commit, ...(checked !== commit ? { reviewedCommit: checked } : {}), merge: first });
  }
  // The paths the landing itself writes after the item merges (badge counts, lowered doctrine counts): data the board
  // derives, never an item's change, so a submit receipt still answers for a tree that differs only there [C7,#3685].
  const landingWrites = new Set();
  if (merged.length && onRunner) for (const file of composed ? composed.writes : await commitDerived(state, merged, hooks)) landingWrites.add(file);
  // A named batch writes its badge documents inside the runner job (above); only the local path writes them here [C7,#5583].
  if (merged.length && !onRunner) {
    const changed = state.landingPorts.writeBadges(batch.root, state.landingPorts.badgeCounts(state.board));
    for (const file of changed) landingWrites.add(file);
    if (changed.length) {
      git(batch.root, ['add', '--', ...changed]);
      const tip = headCommit(batch.root);
      const parents = git(batch.root, ['rev-list', '--parents', '-n', '1', tip]).split(' ');
      if (tip !== batch.base && parents.length === (squash ? 2 : 3) && merged.some(entry => entry.merge === tip)) {
        // Badges belong to the final item merge, preserving its parents/trailer and first-containing receipt.
        git(batch.root, [...hooks, 'commit', '--amend', '--no-edit']);
        const refreshed = headCommit(batch.root);
        for (const entry of merged) if (entry.merge === tip) entry.merge = refreshed;
      } else {
        // An already-contained item may create no merge: never amend the existing trunk's history.
        git(batch.root, [...hooks, 'commit', '-m', 'chore: refresh board badge counts']);
      }
    }
  }
  let doctrineCounts = [];
  const beforeDoctrine = headCommit(batch.root);
  try {
    if (merged.length) doctrineCounts = await tightenLandingDoctrine(batch.root, state.config, { onWait: state.onWait, measured: onRunner ? state.measuredRules : undefined });
  } catch (error) {
    await save(state, { state: 'blocked', items: merged, conflicts, tip: headCommit(batch.root), doctrineCounts: [] });
    throw error;
  }
  for (const change of doctrineCounts) state.say(`doctrine ${change.id}: ${change.before} -> ${change.count}`);
  const tip = headCommit(batch.root);
  if (tip !== beforeDoctrine) for (const file of git(batch.root, ['diff', '--name-only', '-z', beforeDoctrine, tip]).split('\0').filter(Boolean)) landingWrites.add(file);
  state.landingWrites = [...landingWrites].sort();
  requireLandingCompanions(batch.root, state.board, merged, tip);
  // A named batch is scanned by the runner job beside its static checks (step/trunk.js), not on the coordinator [C7,#5559].
  // The secret scan stays on the coordinator either way: the runner runs the candidate's own scan.js [#5968].
  if (scanRidesRunner(state)) requireLandingSecretFree(batch.root, batch.base, tip); else await requireLandingModuleResolution(batch.root, batch.base, tip);
  return { items: merged, conflicts, resolutions, tip, doctrineCounts };
}

export { amendLandingEngines };
export { firstContainingCommit };

/** Validate and snapshot process-local providers before any landing admission or worker action. */
export function landingOperations(ports) {
  const names = ['badgeCounts', 'writeBadges', 'flakeLedger', 'flakeSource', 'observeNativeFailure', 'quarantineWaivers', 'parseProcessCensus',
    'quarantineVerdictSnapshot', 'validateQuarantineGate', 'validateQuarantineLandingProof', 'gateRuns', 'landingFlakeRatchet'];
  if (!names.every(name => typeof ports?.[name] === 'function')) throw new TypeError('landing needs explicit canonical operation ports');
  // badgeDocuments is optional: without it the runner job is handed no badge documents and the coordinator writes them itself [C7,#5583].
  return Object.freeze(Object.fromEntries([...names, ...(typeof ports.badgeDocuments === 'function' ? ['badgeDocuments'] : [])].map(name => [name, ports[name]])));
}
