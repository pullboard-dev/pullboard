/** Retained trunk identity uses only Git state, below committed policy parsing [B34,V6]. */
import { gitSpawnSync } from '../adapter.js';
import {
  cleanGitEnvironment,
  gitConfig,
  invalidateGitFacts,
  localConfigIs,
  plainLocalConfigValue,
} from '../main.js';
import { Refused } from '../../../../kernel/browser.js';

/** Retained trunk without Git; undefined when Git must parse the config [B34]. */
export const plainTrunkRef = root => plainLocalConfigValue(root, 'pullboard', 'trunk');

/** Retain the local primary branch outside replicated board data and read-only diagnostics [B34,V6]. */
export function trunkRef(root, branch) {
  // A trunk already recorded as this branch needs no Git process to confirm and nothing written.
  if (branch !== undefined && localConfigIs(root, 'pullboard', 'trunk', branch)) return branch;
  const plain = plainTrunkRef(root);
  if (plain !== undefined && (branch === undefined || branch === plain)) return plain;
  const read = gitConfig(root, 'pullboard.trunk', { local: true, clean: true, flags: false, noReplace: true });
  if (read.status !== 0 && read.status !== 1) throw new Refused('NO_POLICY', 'the retained trunk cannot be read; restore the local Git configuration and retry');
  const current = read.status === 0 ? read.stdout.trim() : null;
  if (branch === undefined || branch === current) return current;
  const saved = gitSpawnSync(['--no-replace-objects', 'config', '--local', '--replace-all', 'pullboard.trunk', branch], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8',
  });
  invalidateGitFacts();
  if (saved.status !== 0) throw new Refused('NO_POLICY', 'the trunk branch cannot be recorded; restore writable local Git configuration and retry');
  return branch;
}

