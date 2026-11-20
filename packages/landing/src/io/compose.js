/** A named batch composed on a runner: item merges, gate repoints and derived files as one job that returns the final commit [C7,#5585]. */
import { pathToFileURL } from 'node:url';
import { git } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { repointLandingGates } from '../../../spec/index.js';
import { stageLandingDerived } from './derive.js';
import { stageTestRegistries } from './registries.js';
import { stageBadgeDocuments } from './derive.js';
import { gitStdin } from './derive.js';
import { measureHeldRules } from './doctrine.js';
import { firstContainingCommit } from './first.js';

/** Printed instead of a result when this checkout lacks the batch's objects or sits on another tree, so the coordinator merges locally. */
export const COMPOSE_UNAVAILABLE = 'LANDING_COMPOSE_UNAVAILABLE';
/** Printed (with the item id) when an item's merge did not apply cleanly; the coordinator then merges locally, where conflicts are resolved. */
export const COMPOSE_CONFLICT = 'LANDING_COMPOSE_CONFLICT=';
/** The prefixes of the lines a compose job prints: the final commit, each item's first-containing commit, and the rest of what it staged. */
export const COMPOSE_TIP = 'LANDING_COMPOSE_TIP=';
export const COMPOSE_MERGES = 'LANDING_COMPOSE_MERGES=';
export const COMPOSE_PACK = 'LANDING_COMPOSE_PACK=';
export const COMPOSE_ENGINES = 'LANDING_COMPOSE_ENGINES=';
export const COMPOSE_RENAMES = 'LANDING_COMPOSE_RENAMES=';
export const COMPOSE_WRITES = 'LANDING_COMPOSE_WRITES=';
export const COMPOSE_RULES = 'LANDING_COMPOSE_RULES=';

/** The value after `flag` on the command line, or undefined. */
function argument(flag) {
  const at = process.argv.indexOf(flag);
  return at < 0 ? undefined : process.argv[at + 1];
}

/** A JSON value passed as base64 on the command line, or the fallback. */
function decoded(flag, fallback) {
  const value = argument(flag);
  return value ? JSON.parse(Buffer.from(value, 'base64').toString('utf8')) : fallback;
}

/**
 * Merge the planned items one by one onto `base`, repoint renamed gates, derive the landing's files and commit them.
 * Why: this is every step of mergeGroup that needed CPU; the coordinator then only fetches the commit and moves main to it.
 * @param {string} root A checkout whose tree is the base's.
 * @returns {{ conflict: number }|{ tip: string, merges: [number, string][], engines: object[], renames: object[], writes: string[], rules: object[]|null }}
 */
export async function composeLanding(root, { base, plan, config, badges, identity, practice, doctrine }) {
  const hooks = ['-c', 'core.hooksPath=/dev/null', '-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`];
  git(root, ['checkout', '--detach', '--quiet', base]);
  const merges = [];
  const renames = [];
  for (const entry of plan) {
    const trunk = git(root, ['rev-parse', 'HEAD']);
    const result = tryGit(root, [...hooks, '-c', 'merge.log=false', 'merge', '--no-ff', '--no-log', entry.commit, '-m', entry.header, '-m', entry.trailers]);
    if (result.status !== 0) {
      tryGit(root, ['merge', '--abort']);
      return { conflict: entry.id };
    }
    const changes = repointLandingGates(root, config, trunk, git(root, ['rev-parse', 'HEAD']));
    if (changes.length) {
      git(root, ['add', '--', config.spec]);
      git(root, [...hooks, 'commit', '--amend', '--no-edit']);
      renames.push({ id: entry.id, changes });
    }
    merges.push([entry.id, firstContainingCommit(root, entry.commit)]);
  }
  // The derived files fold into the last item merge when it is the tip, else they are a commit of their own, as the coordinator did.
  const before = git(root, ['rev-parse', 'HEAD']);
  const { engines } = await stageLandingDerived(root);
  await stageTestRegistries(root, base);
  if (badges.length) stageBadgeDocuments(root, badges);
  if (git(root, ['diff', '--cached', '--name-only']).trim()) {
    if (merges.some(([, merge]) => merge === before)) {
      git(root, [...hooks, 'commit', '--amend', '--no-edit']);
      const refreshed = git(root, ['rev-parse', 'HEAD']);
      for (const pair of merges) if (pair[1] === before) pair[1] = refreshed;
    } else git(root, [...hooks, 'commit', '-m', 'chore: derive engine numbers and generated docs']);
  }
  const tip = git(root, ['rev-parse', 'HEAD']);
  const writes = tip === before ? [] : git(root, ['diff', '--name-only', '-z', before, tip]).split('\0').filter(Boolean);
  const rules = doctrine ? await measureHeldRules(root, { practice }) : null;
  return { tip, merges, engines: engines.assigned, renames, writes, rules: rules ?? null };
}

/** The new objects of `tip` (its commits and trees, not the base's or the items') as a pack the coordinator can unpack. */
async function packOf(root, base, tip, commits) {
  const packed = await gitStdin(root, ['pack-objects', '--revs', '--stdout', '--quiet'], `${tip}\n^${base}\n${commits.map(commit => `^${commit}\n`).join('')}`);
  if (packed.status !== 0) throw new Error('git pack-objects failed');
  return packed.stdout;
}

/** Run as a runner job: compose in the checkout and print the final commit and a pack of its new objects. No top-level await. */
async function main() {
  const root = process.cwd();
  const base = argument('--base');
  const plan = decoded('--plan', []);
  const have = sha => tryGit(root, ['cat-file', '-e', `${sha}^{commit}`]).status === 0;
  if (!have(base) || !plan.every(entry => have(entry.commit)) || git(root, ['rev-parse', 'HEAD^{tree}']) !== git(root, ['rev-parse', `${base}^{tree}`])) {
    process.stdout.write(`${COMPOSE_UNAVAILABLE}\n`);
    return;
  }
  const identity = decoded('--who', { name: 'pullboard', email: 'pullboard@localhost' });
  const composed = await composeLanding(root, { base, plan, identity, config: decoded('--config', {}), badges: decoded('--badges', []), practice: argument('--practice'), doctrine: process.argv.includes('--doctrine') });
  if ('conflict' in composed) { process.stdout.write(`${COMPOSE_CONFLICT}${composed.conflict}\n`); return; }
  process.stdout.write(`${COMPOSE_MERGES}${JSON.stringify(composed.merges)}\n`);
  process.stdout.write(`${COMPOSE_ENGINES}${composed.engines.map(entry => `${entry.name}:${entry.number}`).join(',')}\n`);
  process.stdout.write(`${COMPOSE_RENAMES}${JSON.stringify(composed.renames)}\n`);
  process.stdout.write(`${COMPOSE_WRITES}${JSON.stringify(composed.writes)}\n`);
  if (composed.rules) process.stdout.write(`${COMPOSE_RULES}${JSON.stringify(composed.rules)}\n`);
  if (composed.tip !== base) process.stdout.write(`${COMPOSE_PACK}${(await packOf(root, base, composed.tip, plan.map(entry => entry.commit))).toString('base64')}\n`);
  process.stdout.write(`${COMPOSE_TIP}${composed.tip}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
