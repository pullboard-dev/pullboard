/** A named batch's merges built on a runner: the coordinator fetches the returned commit and moves nothing else [C7,#5585]. */
import { git } from '../../../../git/index.js';
import { tryGit } from '../../../../git/index.js';
import { mainCheckout } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';
import { runStaticChecks } from '../../../../gate/index.js';
import { runnerExecutionServices } from '../../../../runners/index.js';
import { landingExecutionServices } from '../shards.js';
import { COMPOSE_PACK } from '../compose.js';
import { COMPOSE_ENGINES } from '../compose.js';
import { COMPOSE_MERGES } from '../compose.js';
import { COMPOSE_RENAMES } from '../compose.js';
import { COMPOSE_RULES } from '../compose.js';
import { COMPOSE_TIP } from '../compose.js';
import { COMPOSE_WRITES } from '../compose.js';
import { COMPOSE_CONFLICT } from '../compose.js';
import { gitStdin } from '../derive.js';
import { badgeDocuments } from './derive.js';

/** The value after `prefix` on the first output line carrying it, or null. */
function lineValue(output, prefix) {
  const line = String(output ?? '').split('\n').find(entry => entry.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}

/**
 * Compose a named batch on a runner and bring its final commit here as objects only (no merge, no checks).
 * Why: merging, gate repoints, engine numbering, docs and doctrine counts cost the coordinator its CPU; a runner has spare CPU. The coordinator
 * keeps the batch worktree on `base`, so it moves to the returned tip only while main (the base) has not moved since dispatch; a moved
 * base is the caller's reland, which dispatches the job again on the new base.
 * Returns null when the runner could not answer (cached receipt, missing objects, a conflict, a tip that is not base plus the items), so the caller merges locally.
 * @param {object} state The landing state.
 * @param {{ id: number, commit: string, header: string, trailers: string }[]} plan The items in landing order, each with its commit and message.
 */
export async function composeOnRunner(state, plan, { runChecks = state.guardServices?.runStaticChecks ?? runStaticChecks } = {}) {
  const root = state.batch.root;
  const base = state.batch.base;
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
  const practice = /^[\w./-]+$/u.test(state.config.practice ?? '') ? ` --practice ${state.config.practice}` : '';
  const who = { name: tryGit(root, ['config', 'user.name']).stdout || 'pullboard', email: tryGit(root, ['config', 'user.email']).stdout || 'pullboard@localhost' };
  const badges = badgeDocuments(state);
  const command = `node packages/landing/src/io/compose.js --base ${base} --plan ${encode(plan)} --config ${encode({ spec: state.config.spec })} --badges ${encode(badges)} --who ${encode(who)} --doctrine${practice}`;
  const config = { ...state.config, staticChecks: command };
  const ran = await runChecks(root, config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, agent: 'coordinator', onWait: state.onWait, runnerAdmission: { landing: true, itemCheck: false, shortEligible: false } }).catch(() => null);
  const output = ran?.output;
  const tip = lineValue(output, COMPOSE_TIP);
  const merges = lineValue(output, COMPOSE_MERGES);
  if (lineValue(output, COMPOSE_CONFLICT) !== null || tip === null || merges === null) return null;
  const pack = lineValue(output, COMPOSE_PACK);
  if (tip !== base) {
    if (pack === null) return null;
    const unpacked = await gitStdin(root, ['unpack-objects', '-q'], Buffer.from(pack, 'base64'));
    if (unpacked.status !== 0) return null;
  }
  // Only a tip that is the base plus these items counts: every planned commit is in its history and the base is its ancestor.
  const reaches = commit => tryGit(root, ['merge-base', '--is-ancestor', commit, tip]).status === 0;
  if (tryGit(root, ['cat-file', '-e', `${tip}^{commit}`]).status !== 0 || !reaches(base) || !plan.every(entry => reaches(entry.commit))) return null;
  git(root, ['checkout', '--detach', '--quiet', tip]);
  const rules = lineValue(output, COMPOSE_RULES);
  state.measuredRules = rules === null ? undefined : JSON.parse(rules);
  const engines = (lineValue(output, COMPOSE_ENGINES) ?? '').split(',').filter(Boolean).map(part => ({ name: part.split(':')[0], number: Number(part.split(':')[1]) }));
  return {
    tip,
    merges: new Map(JSON.parse(merges)),
    assigned: engines,
    renames: JSON.parse(lineValue(output, COMPOSE_RENAMES) ?? '[]'),
    writes: JSON.parse(lineValue(output, COMPOSE_WRITES) ?? '[]'),
  };
}

/**
 * With landing.runnerOnlyCompose on: compose on a runner, then take its tip only while main still equals the batch base, by an
 * update-ref on `refs/pullboard/compose/<batch>` (the objects are already here), with no git merge. A main that moved while the
 * runner composed moves the batch base to it and dispatches the compose once more; a second move refuses LAND_ITEM_MOVED [C7,#10247].
 * Why: a runner-built tip is a fast-forward of the base it was built on, so only an unmoved main lets the coordinator adopt it as is.
 * @param {object} state The landing state; `state.batch.base` is replaced by the new main on a re-dispatch.
 * @param {{ id: number, commit: string, header: string, trailers: string }[]} plan
 * @param {{ compose?: typeof composeOnRunner }} [options] The runner compose (tests).
 * @returns {Promise<Awaited<ReturnType<typeof composeOnRunner>>>} Null when a runner could not answer, so the caller refuses or merges locally.
 */
export async function composeFollowingMain(state, plan, { compose = composeOnRunner } = {}) {
  for (let dispatched = 1; ; dispatched++) {
    const composed = await compose(state, plan);
    if (!composed) return null;
    const main = mainCheckout(state.root)?.commit;
    if (!main || main === state.batch.base) {
      tryGit(state.root, ['update-ref', `refs/pullboard/compose/${state.batch.id}`, composed.tip]);
      return composed;
    }
    if (dispatched > 1) throw new Refused('LAND_ITEM_MOVED', `main moved again while batch ${state.batch.id} composed on a runner (now ${main.slice(0, 12)}); rebuild the batch from current verified work: pullboard land`);
    state.say?.(`main moved to ${main.slice(0, 12)} while the runner composed; composing again from it`);
    state.batch.base = main;
    git(state.batch.root, ['checkout', '--detach', '--quiet', main]);
  }
}
