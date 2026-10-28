/** Coordinator landing merge step; source-preserving partition of land.js [B3,R3,C7]. */
import { assignEngineNumbers } from './engine-numbers.js';
import { resolveMechanicalIndex } from './mechanical-merge.js';
import { writeFormatTable } from './format-registry.js';
import { refreshLandingDocs } from './landing-docs.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as store from './board.js';
import { git } from './git.js';
import { headCommit } from './git.js';
import { isClean } from './git.js';
import { tryGit } from './git.js';
import { untracked } from './git.js';
import { Refused } from './refused.js';
import { checkLandingMessages } from './landing-message.js';
import { landingContext } from './landing-message.js';
import { tightenLandingDoctrine } from './landing-doctrine.js';
import { staleVerdictRefusal } from './verdict-freshness.js';
import { verdictProjector } from './verdict-freshness.js';

/** Append a durable snapshot before or after each external side effect. */
export async function save(state, patch) {
  const conflicts = [...new Map([...(state.batch.conflicts ?? []), ...(patch.conflicts ?? [])].map((entry) => [entry.id, entry])).values()];
  const resolutions = [...new Map([...(state.batch.resolutions ?? []), ...(patch.resolutions ?? [])]
    .map(entry => [JSON.stringify(entry), entry])).values()];
  state.batch = await state.write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...state.batch, ...patch, conflicts, resolutions }, revision: state.batch.revision ?? 0 }]);
  return state.batch;
}

/** Merge one ordered group from the immutable batch base, preserving each first-containing commit. */
export async function mergeGroup(state, items) {
  await state.checkLease();
  const { batch } = state;
  if (!isClean(batch.root) || untracked(batch.root).length) throw new Refused('LAND_DIRTY', 'the landing worktree has unfinished edits; inspect its recorded path before adopting');
  git(batch.root, ['checkout', '--detach', batch.base]);
  // Every message is built and checked before the first merge, so a bad one cannot land half a batch.
  const messages = checkLandingMessages(items.map((entry) => store.getItem(state.board, entry.id ?? entry.item_id)),
    landingContext(batch.root, batch.base, state.config, (item) => store.checkedLandingCommit(state.board, item)));
  const merged = [];
  const conflicts = [];
  const resolutions = [];
  for (const entry of items) {
    await state.checkLease();
    const item = store.getItem(state.board, entry.id ?? entry.item_id);
    if (item.item_status !== 'verified' || item.item_commit !== (entry.commit ?? item.item_commit)) throw new Refused('LAND_ITEM_MOVED', `item #${item.item_id} changed; rebuild the batch from current verified work`);
    const checked = store.checkedLandingCommit(state.board, item);
    if (checked !== (entry.reviewedCommit ?? entry.commit ?? item.item_commit)) throw new Refused('LAND_ITEM_MOVED', `item #${item.item_id} was re-reviewed; rebuild its landing from the checked commit`);
    const stale = verdictProjector(state.root, state.board, { main: batch.base }, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem }).state(item);
    if (stale) throw staleVerdictRefusal(item, stale);
    // The body is the trailer paragraph alone: the header carries the title, and no lane branch is named [B3,R3].
    // merge.log is switched off on this call, so a local Git config cannot append a shortlog to the body.
    const trunk = headCommit(batch.root);
    const message = messages.get(item.item_id);
    const result = tryGit(batch.root, ['-c', 'merge.log=false', 'merge', '--no-ff', '--no-log', checked, '-m', message.header, '-m', message.trailers]);
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
        git(batch.root, ['commit', '-m', message.header, '-m', message.trailers]);
        resolutions.push({ id: item.item_id, files, entries: resolution.entries });
        state.say(`mechanical merge #${item.item_id}: ${files.join(', ')}`);
      } else {
        git(batch.root, ['merge', '--abort']);
        conflicts.push({ id: item.item_id, files: resolution.files, trunk, commit: item.item_commit, reviewedCommit: checked });
        state.say(`conflict #${item.item_id}: ${resolution.files.join(', ')}`);
        continue;
      }
    }
    // An engine the item added without a number gets the next one now, in landing order, inside its own merge (#1101).
    const engines = assignEngineNumbers(batch.root);
    if (existsSync(join(batch.root, 'src', 'formats')) && existsSync(join(batch.root, 'docs', 'formats.md'))
      && writeFormatTable(batch.root) && !engines.files.includes('docs/formats.md')) engines.files.push('docs/formats.md');
    for (const file of refreshLandingDocs(batch.root)) if (!engines.files.includes(file)) engines.files.push(file);
    if (engines.files.length) {
      git(batch.root, ['add', '--', ...engines.files]);
      git(batch.root, ['commit', '--amend', '--no-edit']);
      for (const engine of engines.assigned) state.say(`engine ${engine.name}: ${engine.number} for #${item.item_id}`);
    }
    const first = git(batch.root, ['rev-list', '--first-parent', '--reverse', 'HEAD']).split('\n')
      .find((commit) => tryGit(batch.root, ['merge-base', '--is-ancestor', checked, commit]).status === 0);
    merged.push({ id: item.item_id, commit: item.item_commit, ...(checked !== item.item_commit ? { reviewedCommit: checked } : {}), merge: first });
  }
  if (merged.length) {
    const changed = state.landingPorts.writeBadges(batch.root, state.landingPorts.badgeCounts(state.board));
    if (changed.length) {
      git(batch.root, ['add', '--', ...changed]);
      const tip = headCommit(batch.root);
      const parents = git(batch.root, ['rev-list', '--parents', '-n', '1', tip]).split(' ');
      if (tip !== batch.base && parents.length === 3 && merged.some(entry => entry.merge === tip)) {
        // Badges belong to the final item merge, preserving its parents/trailer and first-containing receipt.
        git(batch.root, ['commit', '--amend', '--no-edit']);
        const refreshed = headCommit(batch.root);
        for (const entry of merged) if (entry.merge === tip) entry.merge = refreshed;
      } else {
        // An already-contained item may create no merge: never amend the existing trunk's history.
        git(batch.root, ['commit', '-m', 'chore: refresh board badge counts']);
      }
    }
  }
  let doctrineCounts = [];
  try {
    if (merged.length) doctrineCounts = await tightenLandingDoctrine(batch.root, state.config, { onWait: state.onWait });
  } catch (error) {
    await save(state, { state: 'blocked', items: merged, conflicts, tip: headCommit(batch.root), doctrineCounts: [] });
    throw error;
  }
  for (const change of doctrineCounts) state.say(`doctrine ${change.id}: ${change.before} -> ${change.count}`);
  return { items: merged, conflicts, resolutions, tip: headCommit(batch.root), doctrineCounts };
}

/** Validate and snapshot process-local providers before any landing admission or worker action. */
export function landingOperations(ports) {
  const names = ['badgeCounts', 'writeBadges', 'flakeSource', 'observeNativeFailure', 'quarantineWaivers', 'parseProcessCensus'];
  if (!names.every(name => typeof ports?.[name] === 'function')) throw new TypeError('landing needs explicit canonical operation ports');
  return Object.freeze(Object.fromEntries(names.map(name => [name, ports[name]])));
}
