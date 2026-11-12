/** A named landing's derived files built on a runner: the coordinator applies the returned patch and commits [C7,#5568]. */
import { existsSync } from 'node:fs';
import { git } from '../../../../git/index.js';
import { headCommit } from '../../../../git/index.js';
import { headTree } from '../../../../git/index.js';
import { runStaticChecks } from '../../../../gate/index.js';
import { runnerExecutionServices } from '../../../../runners/index.js';
import { landingExecutionServices } from '../shards.js';
import { stageLandingDerived } from '../derive.js';
import { stageTestRegistries } from '../registries.js';
import { scanRidesRunner } from '../scan.js';
import { gitStdin } from '../derive.js';
import { join } from 'node:path';
import { DERIVE_ENGINES } from '../derive.js';
import { DERIVE_PATCH } from '../derive.js';
import { DERIVE_TREE } from '../derive.js';
import { DERIVE_RULES } from '../derive.js';

/** The value after `prefix` on the first output line carrying it, or null. */
function lineValue(output, prefix) {
  const line = String(output ?? '').split('\n').find(entry => entry.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}

/**
 * Derive a named batch's files on a runner and stage them here by applying its patch.
 * Why: engine numbering, the format table and doc generation cost the coordinator seconds of CPU per landing; a runner has spare CPU.
 * Falls back to deriving here when the runner could not answer (cached receipt, other tree, bad patch), so a landing never stalls on it.
 * @returns {Promise<{ assigned: { name: string, number: number }[] }|null>} The numbered engines, or null when the runner could not answer
 */
export async function deriveOnRunner(state, { runChecks = state.guardServices?.runStaticChecks ?? runStaticChecks } = {}) {
  const root = state.batch.root;
  const tree = headTree(root);
  const badges = badgeDocuments(state);
  const practice = /^[\w./-]+$/u.test(state.config.practice ?? '') ? ` --practice ${state.config.practice}` : '';
  const flags = `${badges.length ? ` --badges ${Buffer.from(JSON.stringify(badges)).toString('base64')}` : ''} --doctrine${practice}${state.batch.base ? ` --base ${state.batch.base}` : ''}`;
  const config = { ...state.config, staticChecks: `node packages/landing/src/io/derive.js --tree ${tree}${flags}` };
  // A runner that cannot run the job (no script in an older base, a lost slot) is no reason to stall: the caller derives here instead.
  const ran = await runChecks(root, config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, agent: 'coordinator', onWait: state.onWait, runnerAdmission: { landing: true, itemCheck: false, shortEligible: false } }).catch(() => null);
  const patch = lineValue(ran?.output, DERIVE_PATCH);
  const expected = lineValue(ran?.output, DERIVE_TREE);
  if (patch === null || expected === null) return null;
  if (patch !== '') {
    const applied = await gitStdin(root, ['apply', '--index', '--binary', '-'], Buffer.from(patch, 'base64'));
    if (applied.status !== 0 || git(root, ['write-tree']) !== expected) { git(root, ['reset', '--hard', '--quiet', 'HEAD']); return null; }
  }
  const engines = (lineValue(ran.output, DERIVE_ENGINES) ?? '').split(',').filter(Boolean).map(part => ({ name: part.split(':')[0], number: Number(part.split(':')[1]) }));
  const counted = lineValue(ran.output, DERIVE_RULES);
  state.measuredRules = counted === null ? undefined : JSON.parse(counted);
  return { assigned: engines };
}

/**
 * The badge documents (path and text) this board's counts yield, from the badge port.
 * Why: the runner has no board, so the coordinator hands it finished documents; the port stays the one author of their bytes [C7,#5583].
 */
export function badgeDocuments(state) {
  return state.landingPorts?.badgeDocuments?.(state.landingPorts.badgeCounts(state.board)) ?? [];
}

/**
 * After a named batch's item merges: stage the derived files from a runner (else here) and fold them into the last item merge,
 * or commit them on their own when that merge is not the tip. Resolves the paths it changed.
 */
export async function commitDerived(state, merged, hooks) {
  const root = state.batch.root;
  const before = headCommit(root);
  let derived = await deriveOnRunner(state);
  if (!derived) {
    // The coordinator writes the badge documents itself when no runner answered.
    const written = state.landingPorts?.writeBadges(root, state.landingPorts.badgeCounts(state.board)) ?? [];
    if (written.length) git(root, ['add', '--', ...written]);
    derived = stageLandingDerived(root).engines;
    await stageTestRegistries(root, state.batch.base);
    state.say('the runner could not derive this batch; engine numbers and docs were built on the coordinator');
  }
  for (const engine of derived.assigned) state.say(`engine ${engine.name}: ${engine.number}`);
  if (git(root, ['diff', '--cached', '--name-only']).trim()) {
    if (merged.some(entry => entry.merge === before)) {
      git(root, [...hooks, 'commit', '--amend', '--no-edit']);
      const refreshed = headCommit(root);
      for (const entry of merged) if (entry.merge === before) entry.merge = refreshed;
    } else git(root, [...hooks, 'commit', '-m', 'chore: derive engine numbers and generated docs']);
  }
  return headCommit(root) === before ? [] : git(root, ['diff', '--name-only', '-z', before, 'HEAD']).split('\0').filter(Boolean);
}

/** Whether this batch derives on a runner: a named batch whose tree carries the derive script and rides runner jobs for its scan. */
export function deriveRidesRunner(state) {
  return scanRidesRunner(state) && existsSync(join(state.batch.root, 'packages/landing/src/io/derive.js'));
}
