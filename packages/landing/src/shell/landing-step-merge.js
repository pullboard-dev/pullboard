import { requireLandingCompanions } from './landing-composition-guards.js';
import { requireLandingModuleResolution } from './landing-composition-guards.js';
import { repointLandingGates } from '../../../spec/index.js';
/** Coordinator landing merge step; source-preserving partition of land.js [B3,R3,C7]. */
import { assignEngineNumbers } from '../../../../src/engine-numbers.js';
import { placeLandingHistory } from './landing-history-plan.js';
import { GENERATED_DOC_PATHS } from '../../../merge/index.js';
import { resolveMechanicalIndex } from '../../../merge/index.js';
import { writeFormatTable } from '../../../state/index.js';
import { refreshLandingDocs } from './landing-docs.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../../src/board.js';
import { git } from '../../../../src/git.js';
import { headCommit } from '../../../../src/git.js';
import { isClean } from '../../../../src/git.js';
import { tryGit } from '../../../../src/git.js';
import { untracked } from '../../../../src/git.js';
import { Refused } from '../../../kernel/index.js';
import { checkLandingMessages } from '../core/landing-message.js';
import { landingContext } from '../core/landing-message.js';
import { tightenLandingDoctrine } from './landing-doctrine.js';
import { staleVerdictRefusal } from '../../../verify/index.js';
import { verdictProjector } from '../../../verify/index.js';
import { landingHooks } from './landing-step-selection.js';

/** Append a durable snapshot before or after each external side effect. */
export async function save(state, patch) {
  const conflicts = [...new Map([...(state.batch.conflicts ?? []), ...(patch.conflicts ?? [])].map((entry) => [entry.id, entry])).values()];
  const resolutions = [...new Map([...(state.batch.resolutions ?? []), ...(patch.resolutions ?? [])]
    .map(entry => [JSON.stringify(entry), entry])).values()];
  state.batch = await state.write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...state.batch, ...patch, conflicts, resolutions }, revision: state.batch.revision ?? 0 }]);
  return state.batch;
}

/** Find the earliest first-parent commit containing a source using the monotone ancestry predicate. */
export function firstContainingCommit(root, source) {
  const commits = git(root, ['rev-list', '--first-parent', 'HEAD']).split('\n').filter(Boolean);
  if (!commits.length) return undefined;
  /** Test one point in the first-parent chain; ancestry is false before the first containing point and true after it. */
  const contains = (commit) => {
    const result = tryGit(root, ['merge-base', '--is-ancestor', source, commit]);
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new Refused('LAND_GIT', `could not locate the first landing containing ${source}: ${result.stderr || result.stdout}`);
  };
  if (!contains(commits[0])) return undefined;
  let containing = 0;
  let absent = commits.length;
  while (absent - containing > 1) {
    const middle = Math.floor((containing + absent) / 2);
    if (contains(commits[middle])) containing = middle;
    else absent = middle;
  }
  return commits[containing];
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

/** Merge one ordered group from the immutable batch base, preserving each first-containing commit. */
export async function mergeGroup(state, items) {
  await state.checkLease();
  const { batch } = state;
  if (!isClean(batch.root) || untracked(batch.root).length) await resetDirtyOnce(state);
  git(state.batch.root, ['checkout', '--detach', state.batch.base]);
  // Every message is built and checked before the first merge, so a bad one cannot land half a batch.
  const messages = checkLandingMessages(items.map((entry) => store.getItem(state.board, entry.id ?? entry.item_id)),
    landingContext(batch.root, batch.base, state.config, (item) => store.checkedLandingCommit(state.board, item)));
  const merged = [];
  const conflicts = [];
  const resolutions = [];
  // A per-item landing merges the reviewed commit with repository hooks off: they ran when the item was built [C7,#2901].
  const hooks = landingHooks(state.config);
  for (const entry of items) {
    await state.checkLease();
    const item = store.getItem(state.board, entry.id ?? entry.item_id);
    if (item.item_status !== 'verified' || item.item_commit !== (entry.commit ?? item.item_commit)) throw new Refused('LAND_ITEM_MOVED', `item #${item.item_id} changed; rebuild the batch from current verified work`);
    const checked = store.checkedLandingCommit(state.board, item);
    if (checked !== (entry.reviewedCommit ?? entry.commit ?? item.item_commit)) throw new Refused('LAND_ITEM_MOVED', `item #${item.item_id} was re-reviewed; rebuild its landing from the checked commit`);
    requireLandingCompanions(batch.root, state.board, [item], checked);
    const stale = verdictProjector(state.root, state.board, { main: batch.base }, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem }).state(item);
    if (stale) throw staleVerdictRefusal(item, stale);
    // The body is the trailer paragraph alone: the header carries the title, and no lane branch is named [B3,R3].
    // merge.log is switched off on this call, so a local Git config cannot append a shortlog to the body.
    const trunk = headCommit(batch.root);
    const message = messages.get(item.item_id);
    const result = tryGit(batch.root, [...hooks, '-c', 'merge.log=false', 'merge', '--no-ff', '--no-log', checked, '-m', message.header, '-m', message.trailers]);
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
    const engines = amendLandingEngines(batch.root, hooks);
    for (const engine of engines.assigned) state.say(`engine ${engine.name}: ${engine.number} for #${item.item_id}`);
    const first = firstContainingCommit(batch.root, checked);
    merged.push({ id: item.item_id, commit: item.item_commit, ...(checked !== item.item_commit ? { reviewedCommit: checked } : {}), merge: first });
  }
  // The paths the landing itself writes after the item merges (badge counts, lowered doctrine counts): data the board
  // derives, never an item's change, so a submit receipt still answers for a tree that differs only there [C7,#3685].
  const landingWrites = new Set();
  if (merged.length) {
    const changed = state.landingPorts.writeBadges(batch.root, state.landingPorts.badgeCounts(state.board));
    for (const file of changed) landingWrites.add(file);
    if (changed.length) {
      git(batch.root, ['add', '--', ...changed]);
      const tip = headCommit(batch.root);
      const parents = git(batch.root, ['rev-list', '--parents', '-n', '1', tip]).split(' ');
      if (tip !== batch.base && parents.length === 3 && merged.some(entry => entry.merge === tip)) {
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
    if (merged.length) doctrineCounts = await tightenLandingDoctrine(batch.root, state.config, { onWait: state.onWait });
  } catch (error) {
    await save(state, { state: 'blocked', items: merged, conflicts, tip: headCommit(batch.root), doctrineCounts: [] });
    throw error;
  }
  for (const change of doctrineCounts) state.say(`doctrine ${change.id}: ${change.before} -> ${change.count}`);
  const tip = headCommit(batch.root);
  if (tip !== beforeDoctrine) for (const file of git(batch.root, ['diff', '--name-only', '-z', beforeDoctrine, tip]).split('\0').filter(Boolean)) landingWrites.add(file);
  state.landingWrites = [...landingWrites].sort();
  requireLandingCompanions(batch.root, state.board, merged, tip);
  await requireLandingModuleResolution(batch.root, batch.base, tip);
  return { items: merged, conflicts, resolutions, tip, doctrineCounts };
}

/** Allocate and stage engine history, then place it before amending that same item merge; hooks are extra Git flags. */
export function amendLandingEngines(root, hooks = []) {
  const engines = assignEngineNumbers(root);
  if (existsSync(join(root, 'src', 'formats')) && existsSync(join(root, 'docs', 'formats.md'))
    && writeFormatTable(root) && !engines.files.includes('docs/formats.md')) engines.files.push('docs/formats.md');
  refreshLandingDocs(root);
  const generatedChanges = git(root, ['diff', '--name-only', 'HEAD', '--', ...GENERATED_DOC_PATHS]).split('\n').filter(Boolean);
  for (const file of generatedChanges) if (!engines.files.includes(file)) engines.files.push(file);
  if (engines.files.length) {
    // Canonical rule placement accepts only staged regular files, including this just-generated history.
    git(root, ['add', '--', ...engines.files]);
    const placed = placeLandingHistory(root, engines.files);
    if (placed.length) git(root, ['add', '--', ...placed]);
    git(root, [...hooks, 'commit', '--amend', '--no-edit']);
  }
  return engines;
}

/** Validate and snapshot process-local providers before any landing admission or worker action. */
export function landingOperations(ports) {
  const names = ['badgeCounts', 'writeBadges', 'flakeLedger', 'flakeSource', 'observeNativeFailure', 'quarantineWaivers', 'parseProcessCensus',
    'quarantineVerdictSnapshot', 'validateQuarantineGate', 'validateQuarantineLandingProof', 'gateRuns', 'landingFlakeRatchet'];
  if (!names.every(name => typeof ports?.[name] === 'function')) throw new TypeError('landing needs explicit canonical operation ports');
  return Object.freeze(Object.fromEntries(names.map(name => [name, ports[name]])));
}
