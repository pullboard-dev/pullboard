/** Warm the shared cells fixture memo on a runner when a new main changes the fixture analyzer [C7]. */
import { trustedRunnerStep } from './submit/gate.js';
import { controllerMemoStore } from './memo.js';
import { keepRunnerFixtureMemo } from './memo.js';
import { fixtureMemoArtifact } from './memo.js';
import { PLAN_DIR } from '../../../../packages/codemap/index.js';
import { PLAN_FILE } from '../../../../packages/codemap/index.js';
import { withGateSlot } from '../../../../packages/gate/heavy.js';
import { loadMachineSettings } from '../../../../packages/config/index.js';
import { checkCommandDefinition } from '../../../../packages/git/index.js';
import { git } from '../../../../packages/git/index.js';
import { gitChildEnv } from '../../../../packages/git/index.js';
import { fileURLToPath } from 'node:url';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const RESULT = 'PULLBOARD_TRUSTED_RESULT ';

/** The module whose import closure is the fixture analyzer; packages/codemap/src/io/cells/scripts/plan.js names its memo by this closure. */
const ANALYZER = 'packages/codemap/src/io/cells-move-fixtures.js';

/**
 * The warm entry, run from main's archive with the runner's checkout of main as its root: seed the fixture memo from
 * the controller's store, run checkMoved for every moved cell exactly as a gate's cells check does at main, and return
 * the memo. A main whose tooling lacks a part returns an empty result rather than failing.
 */
const WARM_ENTRY = `import * as codemap from './packages/codemap/index.js';
import * as cellsCache from './apps/cli/src/io/cells/cache.js';
import * as gate from './packages/gate/index.js';
import { readFileSync } from 'node:fs';
const root = process.argv[2];
const input = JSON.parse(readFileSync(0, 'utf8'));
const result = { main: input.main, source: input.main, cells: 0 };
const memos = await import('./apps/cli/src/io/memo.js').then(module => module.runnerFixtureMemos(cellsCache, process.env.PULLBOARD_RUNNER_ANALYSIS_ARTIFACT ?? null)).catch(() => null);
if (memos && typeof codemap.checkMoved === 'function' && typeof codemap.cellInventory === 'function') {
  const parsers = { importsIn: gate.importsIn, commonJsIn: gate.commonJsIn };
  const accepted = codemap.readPlan(root), map = codemap.cellReadPathMap(root);
  const inventory = codemap.cellInventory(root, parsers), lintReport = codemap.cellLintReport(root, parsers, { inventory });
  const lintBaseline = codemap.cellLintBaseline(lintReport);
  for (const cell of accepted.cells) {
    if (!cell.paths.some(([from, to]) => map.get(from) === to)) continue;
    codemap.checkMoved(root, accepted, cell.name, { acceptedBase: input.main, lintReport, lintBaseline, inventory });
    result.cells += 1;
  }
  result.fixtureMemo = memos.collect();
}
process.stdout.write(${JSON.stringify(RESULT)} + JSON.stringify(result) + '\\n');
`;

/**
 * True when the first-parent change into `commit` touches the fixture analyzer's import closure or the cells plan,
 * which name and key the fixture memo. Why: only those landings leave every runner's memo cold.
 *
 * @param {string} root
 * @param {string} commit
 * @returns {boolean}
 */
export function changesFixtureAnalyzer(root, commit) {
  const env = gitChildEnv(root);
  const changed = git(root, ['diff', '--name-only', '--no-renames', '-z', `${commit}^1`, commit], { env }).split('\0').filter(Boolean);
  if (changed.some(path => path === PLAN_FILE || path.startsWith(`${PLAN_DIR}/`))) return true;
  const tool = fileURLToPath(new URL('../../../../', import.meta.url));
  const closure = new Set(checkCommandDefinition(tool, [], [fileURLToPath(new URL(`../../../../${ANALYZER}`, import.meta.url))])
    .map(entry => entry.path).filter(path => path.startsWith('project:')).map(path => path.slice('project:'.length)));
  return changed.some(path => closure.has(path));
}

/**
 * When `commit` changes the fixture analyzer, run one runner job that fills the controller's shared fixture memo for
 * that main, so the gates after the landing start warm. Why: after #3981 the first gate after such a landing still
 * built the memo on its runner, 170-620 s, and gates starting meanwhile on other runners built it too (#4045).
 * Never throws: a failed or unplaced warm leaves the store as it was, and gates build the memo as before.
 *
 * @param {string} root The main checkout.
 * @param {string} commit The new main.
 * @param {{ executionServices: { runners: object, landing: object }, slot?: typeof withGateSlot, step?: typeof trustedRunnerStep,
 *   changed?: (root: string, commit: string) => boolean, store?: string, registered?: () => boolean }} services
 * @returns {Promise<{ warmed: boolean, cells?: number, reason?: string }>}
 */
export async function warmFixtureMemo(root, commit, { executionServices, slot = withGateSlot, step = trustedRunnerStep, changed = changesFixtureAnalyzer, store = controllerMemoStore(),
  registered = () => executionServices.runners.effectiveRunners(loadMachineSettings()).length > 0 } = {}) {
  try {
    if (!OID.test(commit ?? '')) return { warmed: false, reason: 'no pinned commit' };
    // No registered runner means no warm, never a wait: the producer that called this exits as before.
    if (!registered()) return { warmed: false, reason: 'no runner registered' };
    if (!changed(root, commit)) return { warmed: false, reason: 'fixture analyzer unchanged' };
    const env = gitChildEnv(root);
    const tree = git(root, ['rev-parse', `${commit}^{tree}`], { env }).trim();
    const pinnedSource = { commit, tree, trunk: { ref: 'refs/heads/main', commit } };
    // The memos ride in the artifact frame, never the request, whose spec is bounded at 1 MiB (#4054).
    const { value, host } = await slot(root, async lease => ({ host: lease.runner?.host ?? null, value: (await step(root, { main: commit, source: commit, stage: 'fixture-warm', entry: WARM_ENTRY,
      data: { main: commit, trunk: commit }, analysisArtifact: fixtureMemoArtifact(lease.runner?.host ?? null, store) ?? undefined }, lease)).value }),
    { executionServices, runnerOnly: true, remote: true, itemCheck: true, agent: 'coordinator', kind: 'analysis', pinnedSource });
    const cells = Number.isSafeInteger(value?.cells) ? value.cells : 0;
    keepRunnerFixtureMemo(value, store, host);
    return { warmed: true, cells };
  } catch (error) {
    return { warmed: false, reason: String(error?.message ?? error).slice(0, 400) };
  }
}
