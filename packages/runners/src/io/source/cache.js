/** Candidate refs fall under the existing per-repository source-cache lease, never object GC [C7]. */
import { constants } from 'node:fs';
import { cpSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SOURCE_CACHE_CANDIDATES = 300;
const PIN = 'source-cache-pin.json';
const INDEX = 'pullboard-candidate-uses.json';
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REF = /^refs\/pullboard\/candidates\/(?:[^\s]+\/)?[a-f0-9]{40,64}$/u;
const BOOTSTRAP = 'git-committer-date-then-refname; not observed last use';

/** Publish the current spec roots before cache admission; no job lifecycle or orphan-death registry is needed. */
export function pinSourceCacheJob(directory, spec) {
  const roots = [...new Set([spec.commit, ...(spec.trunk ? [spec.trunk.commit] : []),
    ...(spec.trustedMode ? [spec.trustedMode.policyCommit, spec.trustedMode.trunk.commit] : [])])];
  if (!/^[a-f0-9]{64}$/u.test(spec.repoId) || !roots.length || roots.some(root => !SHA.test(root))) {
    throw new Error('source cache job pin has invalid roots');
  }
  writeFileSync(join(directory, PIN), JSON.stringify({ version: 1, repoId: spec.repoId, roots }) + '\n', { mode: 0o600, flag: 'wx' });
  return roots;
}

/** Collect named current-spec roots; unrecognised leftovers are reported, never a global pruning veto. */
function jobPins(runnerRoot, repoId) {
  const roots = new Set();
  let unknown = false;
  const jobs = join(runnerRoot, 'jobs');
  try {
    for (const entry of readdirSync(jobs, { withFileTypes: true })) {
      if (!entry.isDirectory()) { unknown = true; continue; }
      const file = join(jobs, entry.name, PIN);
      try {
        if (!lstatSync(file).isFile() || statSync(file).size > 4096) throw new Error('unknown job pin');
        const pin = JSON.parse(readFileSync(file, 'utf8'));
        if (pin.version !== 1 || !/^[a-f0-9]{64}$/u.test(pin.repoId) || !Array.isArray(pin.roots)
          || !pin.roots.length || pin.roots.length > 4 || pin.roots.some(root => !SHA.test(root))) throw new Error('unknown job pin');
        if (pin.repoId === repoId) for (const root of pin.roots) roots.add(root);
      } catch (error) {
        // Missing legacy metadata does not name a root. Removing its cache ref only causes normal refetch.
        if (!existsSync(join(jobs, entry.name))) continue;
        unknown = true;
      }
    }
  } catch { unknown = true; }
  return { roots, unknown };
}

/** Load only actual observed-use ordinals; absent legacy records retain explicitly labelled bootstrap ordering. */
function readUses(cache) {
  const file = join(cache, INDEX);
  if (!existsSync(file)) return { version: 1, next: 0, bootstrapOrder: BOOTSTRAP, uses: [] };
  if (!lstatSync(file).isFile() || statSync(file).size > 16 * 1024 ** 2) throw new Error('source cache use index is invalid');
  const index = JSON.parse(readFileSync(file, 'utf8'));
  if (index.version !== 1 || index.bootstrapOrder !== BOOTSTRAP || !Number.isSafeInteger(index.next) || index.next < 0
    || !Array.isArray(index.uses) || index.uses.some(row => !Array.isArray(row) || row.length !== 2 || !REF.test(row[0])
      || !Number.isSafeInteger(row[1]) || row[1] <= 0 || row[1] > index.next)
    || new Set(index.uses.map(row => row[0])).size !== index.uses.length) throw new Error('source cache use index is invalid');
  return index;
}

/** Atomically replace private local cache metadata while its existing resource lease is held. */
function writeUses(cache, index) {
  const file = join(cache, INDEX), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(index) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/** Validate every retained candidate/published object before any ref deletion or inventory announcement. */
async function cacheRefs(cache, git, env, proven) {
  const text = await git(cache, ['for-each-ref', '--format=%(refname) %(objectname) %(committerdate:unix)',
    'refs/pullboard/candidates', 'refs/pullboard/published'], env);
  const refs = text ? text.split(/\r?\n/u).map(line => {
    const match = /^(refs\/pullboard\/(candidates|published)\/\S+) ([a-f0-9]{40,64}) (-?\d+)$/u.exec(line);
    if (!match || match[1].slice(match[1].lastIndexOf('/') + 1) !== match[3] || !SHA.test(match[3])) {
      throw new Error('source history cache contains an invalid candidate ref');
    }
    return { name: match[1], kind: match[2], head: match[3], date: Number(match[4]) };
  }) : [];
  const tips = [...new Set(refs.map(ref => ref.head))].filter(tip => !proven.has(tip));
  if (tips.length) {
    const checked = (await git(cache, ['cat-file', '--batch-check'], env, `${tips.join('\n')}\n`)).split(/\r?\n/u);
    if (checked.length !== tips.length || checked.some((line, index) => !new RegExp(`^${tips[index]} commit \\d+$`, 'u').test(line))) {
      throw new Error('source history cache contains an invalid candidate object');
    }
    for (const tip of tips) proven.add(tip);
  }
  return refs;
}

/** Prune only unprotected candidate refs under the caller's actual exclusive repository-cache lease. `proven` is the
 * set of object ids this checkout already verified as commits; object types never change, so each id is checked once.
 * Optional `inventory` receives only actual retained refs after Git has committed any deletions. */
export async function pruneSourceCache({ cache, runnerRoot, repoId, roots, lease, git, env, limit = SOURCE_CACHE_CANDIDATES, log = () => {}, proven = new Set(), inventory }) {
  if (typeof lease?.release !== 'function' || !Number.isSafeInteger(limit) || limit < 1 || roots.some(root => !SHA.test(root))) {
    throw new Error('source cache pruning requires its owned lease and valid candidate bound');
  }
  const refs = await cacheRefs(cache, git, env, proven), index = readUses(cache), uses = new Map(index.uses);
  const pins = jobPins(runnerRoot, repoId), protectedRoots = new Set([...roots, ...pins.roots]);
  for (const ref of refs) if (ref.kind === 'published') protectedRoots.add(ref.head);
  for (const root of roots) {
    if (index.next >= Number.MAX_SAFE_INTEGER) throw new Error('source cache use ordinals are exhausted');
    uses.set(`refs/pullboard/candidates/${root}`, ++index.next);
  }
  const candidates = refs.filter(ref => ref.kind === 'candidates');
  const protectedRefs = candidates.filter(ref => protectedRoots.has(ref.head));
  const ordered = [...candidates].sort((left, right) => {
    const leftUse = uses.get(left.name), rightUse = uses.get(right.name);
    if (leftUse !== undefined || rightUse !== undefined) return (rightUse ?? -1) - (leftUse ?? -1);
    return right.date - left.date || left.name.localeCompare(right.name, 'en');
  });
  const remove = ordered.slice(limit).filter(ref => !protectedRoots.has(ref.head));
  if (remove.length) {
    // Git validates every old object ID and acquires all ref locks before committing any deletion.
    await git(cache, ['update-ref', '--stdin'], env,
      `start\n${remove.map(ref => `delete ${ref.name} ${ref.head}`).join('\n')}\nprepare\ncommit\n`);
  }
  const removed = new Set(remove.map(ref => ref.name));
  if (inventory) {
    inventory.clear();
    for (const ref of refs) if (!removed.has(ref.name)) inventory.set(ref.name, ref.head);
  }
  const retained = new Set(candidates.filter(ref => !removed.has(ref.name)).map(ref => ref.name));
  for (const root of roots) retained.add(`refs/pullboard/candidates/${root}`);
  index.uses = [...uses].filter(([name]) => retained.has(name)).sort(([left], [right]) => left.localeCompare(right, 'en'));
  writeUses(cache, index);
  const result = { pruned: remove.map(ref => ref.name), retained: candidates.length - remove.length,
    protected: protectedRefs.length, overage: Math.max(0, candidates.length - remove.length - limit),
    unknownPins: pins.unknown, bootstrapOrder: BOOTSTRAP };
  if (result.pruned.length || result.overage || result.unknownPins) {
    appendFileSync(join(cache, 'pullboard-pruned-refs.jsonl'), JSON.stringify({ ordinal: index.next, ...result }) + '\n', { mode: 0o600 });
    log(result);
  }
  return result;
}

/** Restore only an ancestor's private pre-command checkout while the repository-cache lease is held. */
export async function restoreSourceTree({ directory, root, commit, history, lease, git, env }) {
  if (typeof lease?.release !== 'function') throw new Error('source tree reuse requires its repository-cache lease');
  if (!existsSync(directory)) return null;
  if (!lstatSync(directory).isDirectory()) throw new Error('source tree cache is not a private directory');
  const metadata = join(directory, '.git', 'pullboard-source-snapshot.json');
  if (!lstatSync(metadata).isFile() || statSync(metadata).size > 1024) throw new Error('source tree metadata is invalid');
  const value = JSON.parse(readFileSync(metadata, 'utf8'));
  if (value.version !== 1 || !SHA.test(value.commit) || !SHA.test(value.tree) || value.commit.length !== commit.length) {
    throw new Error('source tree metadata is invalid');
  }
  if (!history.has(value.commit)) return null;
  // No hard links or alternates: a command may write any file in its own private repository.
  cpSync(directory, root, { recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
  const actual = (await git(root, ['rev-parse', 'HEAD', 'HEAD^{tree}'], env)).split(/\r?\n/u);
  if (actual.length !== 2 || actual[0] !== value.commit || actual[1] !== value.tree
    || existsSync(join(root, '.git', 'objects', 'info', 'alternates'))
    || await git(root, ['status', '--porcelain=v1', '--untracked-files=all'], env)) {
    throw new Error('source tree cache does not match its clean committed base');
  }
  return value.commit;
}

/** Keep one bounded pre-policy, pre-tag, pre-command base tree; publication never aliases a job's writable files. */
export function rememberSourceTree({ directory, root, commit, tree, lease }) {
  if (typeof lease?.release !== 'function' || !SHA.test(commit) || !SHA.test(tree)) {
    throw new Error('source tree publication requires its repository-cache lease and exact source');
  }
  const staging = mkdtempSync(directory + '.staging-');
  const staged = join(staging, 'checkout');
  const old = directory + '.old-' + randomUUID();
  let replaced = false;
  let published = false;
  try {
    cpSync(root, staged, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
    writeFileSync(join(staged, '.git', 'pullboard-source-snapshot.json'), JSON.stringify({ version: 1, commit, tree }) + '\n', { mode: 0o600 });
    if (existsSync(directory)) { renameSync(directory, old); replaced = true; }
    try { renameSync(staged, directory); published = true; }
    catch (error) { if (replaced) renameSync(old, directory); throw error; }
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (published) rmSync(old, { recursive: true, force: true });
  }
}

/** Ask Git to validate every tag suffix in one abort-only transaction under the source-cache lease. */
export async function checkSourceTagNames({ cache, tags, id, lease, git, env, objectLength }) {
  if (typeof lease?.release !== 'function' || !/^[A-Za-z0-9_-]{1,100}$/u.test(id)
    || ![40, 64].includes(objectLength) || tags.some(tag => typeof tag.name !== 'string'
      || !tag.name.startsWith('refs/tags/') || /[\u0000-\u0020\u007f]/u.test(tag.name))) {
    throw new Error('source tag names cannot be validated');
  }
  if (!tags.length) return;
  // The added valid prefix preserves every Git ref-name rule on refs/tags/<suffix>. The fresh
  // job namespace has no refs: verify-zero + prepare asks Git itself to validate them, then abort
  // releases every lock without publishing any tag or permitting a candidate to mutate cache refs.
  const zero = '0'.repeat(objectLength);
  const checks = tags.map(tag => `verify refs/pullboard/tag-format/${id}/${tag.name} ${zero}`);
  await git(cache, ['update-ref', '--stdin'], env, `start\n${checks.join('\n')}\nprepare\nabort\n`);
}
