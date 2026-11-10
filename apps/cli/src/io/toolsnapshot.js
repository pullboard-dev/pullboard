/** A new tools snapshot is an idle kept one moved to the new tooling commit: only the files that differ are written [C7]. */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { queuedToolOwners } from '../../../../packages/items/index.js';
import { toolTreeHasLiveOwner } from '../../../../packages/items/index.js';
import { gitSpawnSync } from '../../../../packages/git/light.js';

/**
 * The Git index a shared snapshot keeps inside its own folder, so the folder moves as one rename and a later
 * snapshot knows exactly which tree the files on disk are. No tool path is named like it.
 */
export const TOOLS_INDEX = '.pullboard-tools-index';

/** A shared snapshot folder: one per tooling digest. */
const SHARED = /^pullboard-handoff-tools-[0-9a-f]{40}$/u;

/**
 * How long a snapshot must sit untouched before another tooling commit may take it. Why: a submit that reuses a
 * snapshot touches it before it names it in its request and launch ticket, so a recently touched one may be about
 * to start a gate that no request or process names yet.
 */
export const TOOLS_IDLE_MS = 10 * 60_000;

/** The process environment without the caller's Git variables, so no inherited GIT_DIR or index redirects a command. */
function cleanGitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
}

/**
 * Git on the tool repository with `work` as the work tree and the snapshot's own index; a failure is returned.
 *
 * @param {string} toolRoot - A checkout of the Pullboard repository whose objects hold the tooling commits.
 * @param {string} work - The snapshot folder.
 * @param {string[]} args - Git's arguments.
 * @returns {{ ok: boolean, out: string }}
 */
function indexGit(toolRoot, work, args) {
  const result = gitSpawnSync(['-C', toolRoot, '-c', 'core.autocrlf=false', `--work-tree=${work}`, ...args],
    { encoding: 'utf8', env: { ...cleanGitEnvironment(), GIT_INDEX_FILE: join(work, TOOLS_INDEX) }, maxBuffer: 32 * 1024 * 1024 });
  return { ok: result.status === 0, out: String(result.stdout ?? '').trim() };
}

/**
 * Whether the snapshot's files are exactly its index: nothing modified, deleted or added beside the index file.
 *
 * @param {string} toolRoot
 * @param {string} work
 * @returns {boolean}
 */
function exactlyIndexed(toolRoot, work) {
  indexGit(toolRoot, work, ['update-index', '-q', '--refresh']);
  if (!indexGit(toolRoot, work, ['diff-files', '--quiet']).ok) return false;
  const others = indexGit(toolRoot, work, ['ls-files', '--others', '-z']);
  return others.ok && others.out.split('\0').every(path => path === '' || path === TOOLS_INDEX);
}

/**
 * Whether the snapshot's index is exactly `commit`'s tree and its files are exactly that index.
 *
 * @param {string} toolRoot
 * @param {string} work
 * @param {string} commit
 * @returns {boolean}
 */
function indexedAt(toolRoot, work, commit) {
  const tree = indexGit(toolRoot, work, ['rev-parse', `${commit}^{tree}`]);
  const index = indexGit(toolRoot, work, ['write-tree']);
  return tree.ok && index.ok && index.out === tree.out && exactlyIndexed(toolRoot, work);
}

/**
 * Write `commit`'s tree into the empty folder `work` through the snapshot's own index, so every file and its stat
 * data are recorded as they are written and a later tooling commit can move the folder by the files that differ.
 *
 * @param {string} toolRoot - A checkout of the Pullboard repository.
 * @param {string} work - An empty folder.
 * @param {string} commit - The tooling commit.
 * @returns {boolean} Whether the folder now holds exactly that commit's tree.
 */
export function checkoutCommittedTools(toolRoot, work, commit) {
  return indexGit(toolRoot, work, ['read-tree', '--reset', '-u', commit]).ok && indexedAt(toolRoot, work, commit);
}

/**
 * Record the index of a freshly built snapshot, so a later tooling commit can move it instead of writing every file.
 * It reads the files' stat data and writes only the index. A failure leaves a snapshot that is simply not moved later.
 *
 * @param {string} toolRoot - The Pullboard checkout the snapshot was built from.
 * @param {string} work - The snapshot folder, holding exactly `commit`'s tree.
 * @param {string} commit - The commit the snapshot holds.
 * @returns {boolean} Whether the snapshot can be moved later.
 */
export function keepToolsIndex(toolRoot, work, commit) {
  if (existsSync(join(work, TOOLS_INDEX)) && indexedAt(toolRoot, work, commit)) return true;
  const kept = indexGit(toolRoot, work, ['read-tree', commit]).ok && exactlyIndexed(toolRoot, work)
    && indexedAt(toolRoot, work, commit);
  if (!kept) rmSync(join(work, TOOLS_INDEX), { force: true });
  return kept;
}

/**
 * Take the most recently used idle shared snapshot and move it to `commit`, writing only the files that differ.
 * It is used only when its index's tree id equals the commit's tree id and its files are exactly that index; any
 * other outcome removes the taken folder and returns null, so the caller builds the whole snapshot as before.
 *
 * Why: each tooling change on the coordinator wrote all 4,222 files (60 MB) of a new snapshot, about 13 MB per gate
 * at 37 gates an hour, and the disk work is what caps the gate workers at 16 (#3663).
 *
 * @param {{ toolRoot: string, commit: string, job: string, temp: string, now?: number, idleMs?: number,
 *   owned?: (path: string) => boolean }} options - The tool checkout, the tooling commit wanted, the job naming the
 *   staging folder, the folder holding the snapshots, and test seams for the clock, idle age and the live-owner check.
 * @returns {{ path: string, from: string, written: number } | null} The staging folder now at `commit`, the tree it
 *   was moved from, and the count of files written or removed.
 */
export function advanceIdleToolTree({ toolRoot, commit, job, temp, now = Date.now(), idleMs = TOOLS_IDLE_MS, owned }) {
  const tree = gitSpawnSync(['-C', toolRoot, 'rev-parse', `${commit}^{tree}`], { encoding: 'utf8', env: cleanGitEnvironment() });
  const wanted = String(tree.stdout ?? '').trim();
  if (tree.status !== 0 || !/^[0-9a-f]{40}$/u.test(wanted)) return null;
  const queued = owned ? null : queuedToolOwners({ now });
  const live = owned ?? (path => queued.has(path) || toolTreeHasLiveOwner(path));
  let names = [];
  try { names = readdirSync(temp).filter(name => SHARED.test(name)); } catch { return null; }
  const idle = names.map(name => join(temp, name)).flatMap(path => {
    try { return existsSync(join(path, TOOLS_INDEX)) ? [{ path, usedAt: statSync(path).mtimeMs }] : []; } catch { return []; }
  }).filter(slot => now - slot.usedAt > idleMs).sort((a, b) => b.usedAt - a.usedAt);
  for (const slot of idle) {
    if (live(slot.path)) continue;
    const staging = join(temp, `pullboard-handoff-staging-${job}-${randomUUID()}`);
    try { renameSync(slot.path, staging); } catch { continue; } // another submit took it first
    const moved = moveTo(toolRoot, staging, commit, wanted);
    if (moved) return { path: staging, ...moved };
    rmSync(staging, { recursive: true, force: true });
  }
  return null;
}

/**
 * Move one taken snapshot to `commit` through its index and prove the result by tree id.
 *
 * @param {string} toolRoot
 * @param {string} staging - The taken snapshot.
 * @param {string} commit - The tooling commit wanted.
 * @param {string} wanted - That commit's tree id.
 * @returns {{ from: string, written: number } | null}
 */
function moveTo(toolRoot, staging, commit, wanted) {
  if (!exactlyIndexed(toolRoot, staging)) return null;
  const from = indexGit(toolRoot, staging, ['write-tree']);
  if (!from.ok) return null;
  const changed = indexGit(toolRoot, staging, ['diff-tree', '-r', '--name-only', '-z', from.out, wanted]);
  if (!changed.ok || !indexGit(toolRoot, staging, ['read-tree', '-m', '-u', from.out, commit]).ok) return null;
  const proved = indexGit(toolRoot, staging, ['write-tree']);
  if (!proved.ok || proved.out !== wanted || !exactlyIndexed(toolRoot, staging)) return null;
  return { from: from.out, written: changed.out.split('\0').filter(Boolean).length };
}
