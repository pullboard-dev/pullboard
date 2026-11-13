/** The engine-numbering check on a recorded landing commit, the one automatic landing applies [V4]. */
import { cleanGitEnvironment } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';
import { ENGINE_CANDIDATE } from '../../../../kernel/index.js';
import { gitSpawnSync } from '../../../../git/index.js';

/** The folder the engine leaves live in; landing numbers only the placeholders there [V4]. */
const ENGINE_FOLDER = 'packages/state/src/logic/engines';

/** Recognize the canonical placeholder declaration automatic landing numbers, without executing candidate code. */
function unnumberedEngine(source) {
  const lines = source.split('\n');
  const declarations = lines.filter(line => /^export const /u.test(line));
  return lines.includes("import { unassignedEngine } from './engine-next.js';") && declarations.length === 1
    && /^export const [A-Z][A-Z0-9_]*_ENGINE = unassignedEngine\(\);$/u.test(declarations[0]);
}

/**
 * Refuse a recorded commit that leaves a numbered-engine placeholder unnumbered, reading Git objects alone (no worktree).
 * @param {string} root A checkout of the repository.
 * @param {string} commit The commit about to be recorded as merged.
 * @returns {void} Nothing; an unnumbered engine throws a refusal naming it.
 */
export function requireLandingPlanCheck(root, commit) {
  const env = cleanGitEnvironment();
  const listed = gitSpawnSync(['ls-tree', '-r', '-z', commit, '--', `${ENGINE_FOLDER}/`], { cwd: root, env, encoding: 'utf8' });
  if (listed.status !== 0) throw new Refused('LAND_PLAN_CHECK', `could not read landing commit ${commit.slice(0, 12)}; restore its Git objects and retry merged`);
  const rows = listed.stdout.split('\0').filter(Boolean).map(row => /^(\d{6}) \w+ ([a-f0-9]{40,64})\t([\s\S]+)$/u.exec(row)).filter(Boolean)
    .map(match => ({ mode: match[1], object: match[2], path: match[3] }));
  const leaf = row => row.path.slice(ENGINE_FOLDER.length + 1);
  const candidates = rows.filter(row => !leaf(row).includes('/') && ENGINE_CANDIDATE.test(leaf(row)));
  const pending = candidates.filter(row => {
    if (!/^100(?:644|755)$/u.test(row.mode)) throw new Refused('LAND_PLAN_CHECK', `engine leaf ${row.path} must be a regular source file before recording merged`);
    const blob = gitSpawnSync(['cat-file', 'blob', row.object], { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 ** 2 });
    if (blob.status !== 0) throw new Refused('LAND_PLAN_CHECK', `could not read engine leaf ${row.path} at ${commit.slice(0, 12)}; restore its Git objects and retry merged`);
    return unnumberedEngine(blob.stdout);
  }).map(row => row.path);
  if (pending.length) throw new Refused('LAND_ENGINE_UNNUMBERED', `${commit.slice(0, 12)} leaves unnumbered engines: ${pending.join(', ')}; run amendLandingEngines during landing to assign their numbers, then record the resulting commit`);
}

/**
 * The same check where this machine runs checks; it reads Git objects only, so it never needs a runner.
 * @param {string} root A checkout of the repository.
 * @param {string} commit The commit about to be recorded as merged.
 * @returns {Promise<void>} Nothing; a failing check throws the same refusals.
 */
export async function landingPlanCheck(root, commit) {
  requireLandingPlanCheck(root, commit);
}
