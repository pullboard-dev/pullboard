/** Candidate refs fall under the existing per-repository source-cache lease, never object GC [C7]. */
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

/** Keep accepted job roots protected until native descendant cleanup removes the entire job directory. */
export function pinSourceCacheJob(directory, spec) {
  const roots = [...new Set([spec.commit, ...(spec.trunk ? [spec.trunk.commit] : []),
    ...(spec.trustedMode ? [spec.trustedMode.policyCommit, spec.trustedMode.trunk.commit] : [])])];
  if (!/^[a-f0-9]{64}$/u.test(spec.repoId) || !roots.length || roots.some(root => !SHA.test(root))) {
    throw new Error('source cache job pin has invalid roots');
  }
  writeFileSync(join(directory, PIN), JSON.stringify({ version: 1, repoId: spec.repoId, roots }) + '\n', { mode: 0o600, flag: 'wx' });
  return roots;
}

/** Unknown, legacy, stale or unreadable job ownership never authorizes deleting its possible roots. */
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
        // A job may finish between directory enumeration and pin read. Only its actual disappearance is safe.
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
async function cacheRefs(cache, git, env) {
  const text = await git(cache, ['for-each-ref', '--format=%(refname) %(objectname) %(committerdate:unix)',
    'refs/pullboard/candidates', 'refs/pullboard/published'], env);
  const refs = text ? text.split(/\r?\n/u).map(line => {
    const match = /^(refs\/pullboard\/(candidates|published)\/\S+) ([a-f0-9]{40,64}) (-?\d+)$/u.exec(line);
    if (!match || match[1].slice(match[1].lastIndexOf('/') + 1) !== match[3] || !SHA.test(match[3])) {
      throw new Error('source history cache contains an invalid candidate ref');
    }
    return { name: match[1], kind: match[2], head: match[3], date: Number(match[4]) };
  }) : [];
  const tips = [...new Set(refs.map(ref => ref.head))];
  if (tips.length) {
    const checked = (await git(cache, ['cat-file', '--batch-check'], env, `${tips.join('\n')}\n`)).split(/\r?\n/u);
    if (checked.length !== tips.length || checked.some((line, index) => !new RegExp(`^${tips[index]} commit \\d+$`, 'u').test(line))) {
      throw new Error('source history cache contains an invalid candidate object');
    }
  }
  return refs;
}

/** Prune only unprotected candidate refs under the caller's actual exclusive repository-cache lease. */
export async function pruneSourceCache({ cache, runnerRoot, repoId, roots, lease, git, env, limit = SOURCE_CACHE_CANDIDATES, log = () => {} }) {
  if (typeof lease?.release !== 'function' || !Number.isSafeInteger(limit) || limit < 1 || roots.some(root => !SHA.test(root))) {
    throw new Error('source cache pruning requires its owned lease and valid candidate bound');
  }
  const refs = await cacheRefs(cache, git, env), index = readUses(cache), uses = new Map(index.uses);
  const pins = jobPins(runnerRoot, repoId), protectedRoots = new Set([...roots, ...pins.roots]);
  for (const ref of refs) if (ref.kind === 'published') protectedRoots.add(ref.head);
  for (const root of roots) {
    if (index.next >= Number.MAX_SAFE_INTEGER) throw new Error('source cache use ordinals are exhausted');
    uses.set(`refs/pullboard/candidates/${root}`, ++index.next);
  }
  const candidates = refs.filter(ref => ref.kind === 'candidates');
  const protectedRefs = candidates.filter(ref => protectedRoots.has(ref.head));
  const ordered = candidates.filter(ref => !protectedRoots.has(ref.head)).sort((left, right) => {
    const leftUse = uses.get(left.name), rightUse = uses.get(right.name);
    if (leftUse !== undefined || rightUse !== undefined) return (rightUse ?? -1) - (leftUse ?? -1);
    return right.date - left.date || left.name.localeCompare(right.name, 'en');
  });
  const remove = pins.unknown ? [] : ordered.slice(Math.max(0, limit - protectedRefs.length));
  if (remove.length) {
    // Git validates every old object ID and acquires all ref locks before committing any deletion.
    await git(cache, ['update-ref', '--stdin'], env,
      `start\n${remove.map(ref => `delete ${ref.name} ${ref.head}`).join('\n')}\nprepare\ncommit\n`);
  }
  const removed = new Set(remove.map(ref => ref.name));
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
