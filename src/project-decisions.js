/**
 * One decision list across a project's repos [N34]. A project is the set of registered repos whose
 * pullboard.json names the same non-empty "project"; each repo keeps its own board, so this only
 * reads the sibling boards and never writes one.
 */
import {
  basename,
  join,
  resolve,
} from 'node:path';
import * as store from './board.js';
import { loadConfig } from './config.js';
import { repoInfo } from './git.js';
import { listApiProjects } from './projects.js';
import { Refused } from './refused.js';

/**
 * The other registered repos of this config's project, in registry order.
 *
 * @param {string} root this repo's root
 * @param {{ project?: string }} config this repo's config
 * @param {() => { root: string, name: string, project: string }[]} [projects] the registry reader
 * @returns {{ root: string, name: string }[]} empty when the config names no project
 */
export function projectSiblings(root, config, projects = listApiProjects) {
  if (!config?.project) return [];
  const here = resolve(root);
  return projects()
    .filter((entry) => entry.project === config.project && resolve(entry.root) !== here)
    .map((entry) => ({ root: resolve(entry.root), name: entry.name ?? basename(entry.root) }));
}

/**
 * Name each repo of a project so repo#id is never ambiguous: a repo goes by its configured name,
 * or by its folder name when another repo of the project has the same configured name.
 *
 * @param {{ root: string, name: string }} self this repo
 * @param {{ root: string, name: string }[]} siblings
 * @returns {Map<string, string>} each repo's root to the label that addresses it
 */
export function repoLabels(self, siblings) {
  const all = [self, ...siblings];
  return new Map(all.map((entry) => [entry.root, all.filter((other) => other.name === entry.name).length > 1 ? basename(entry.root) : entry.name]));
}

/**
 * Resolve the repo part of a repo#id reference among this repo and its siblings. A label that
 * matches none, or more than one, refuses with the next step, because answering the wrong board
 * would close somebody else's decision; this repo takes part in the match, so a sibling that shares
 * its name is never silently skipped.
 *
 * @param {string} repo a label from repoLabels, a configured name or a folder name
 * @param {{ root: string, name: string }} self this repo
 * @param {{ root: string, name: string }[]} siblings
 * @returns {{ root: string, name: string }} the repo to answer on; may be this repo
 */
export function resolveRepo(repo, self, siblings) {
  const all = [self, ...siblings];
  const labels = repoLabels(self, siblings);
  const byLabel = all.filter((entry) => labels.get(entry.root) === repo);
  if (byLabel.length === 1) return byLabel[0];
  const found = byLabel.length ? byLabel : all.filter((entry) => entry.name === repo || basename(entry.root) === repo);
  if (found.length === 1) return found[0];
  throw new Refused(found.length ? 'PROJECT_REPO_AMBIGUOUS' : 'PROJECT_REPO_UNKNOWN',
    `${found.length ? 'more than one' : 'no'} repo of this project is named ${repo}; run pullboard decisions --as person to see each repo's name`);
}

/**
 * Every open person decision of this repo and of each sibling repo, as `{ ask, repo, root, agents, config }` with the repo also on the ask.
 * Siblings may carry the `label` that repoLabels gave them. A
 * sibling that cannot be read is skipped and named in `unreadable`, so one broken repo never hides
 * the others' questions.
 *
 * @param {string} root this repo's root
 * @param {string} repo the name this repo goes by
 * @param {any} board this repo's open board
 * @param {{ root: string, name: string }[]} siblings
 * @param {(root: string) => any} [configFor] reads a sibling's config; tests may replace it
 * @returns {{ decisions: any[], unreadable: string[] }}
 */
export function projectPersonDecisions(root, repo, board, siblings, configFor = loadConfig) {
  const decisions = store.openDecisions(board, store.PERSON).map((ask) => ({ ask: { ...ask, repo }, repo, root, agents: store.listAgents(board), config: null }));
  const unreadable = [];
  for (const sibling of siblings) {
    let other = null;
    try {
      other = store.openBoardForRead(join(repoInfo(sibling.root).commonDir, 'pullboard', 'board.sqlite'));
      if (!other) throw new Refused('NO_BOARD', 'no board here');
      const agents = store.listAgents(other);
      let config = null;
      try { config = configFor(sibling.root); } catch { /* names fall back to this repo's settings */ }
      for (const ask of store.openDecisions(other, store.PERSON)) decisions.push({ ask: { ...ask, repo: sibling.label ?? sibling.name }, repo: sibling.label ?? sibling.name, root: sibling.root, agents, config });
    } catch {
      unreadable.push(sibling.label ?? sibling.name);
    } finally {
      try { other?.db.close(); } catch { /* the read is already done */ }
    }
  }
  return { decisions, unreadable };
}
