/** Layer exact changed Git blobs over the accepted inventory without touching a working tree [C7]. */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gitChildEnv,
  gitExecFileSync,
} from '../../../../git/index.js';
import {
  git,
  cellGitEnvironment,
} from './git.js';
import { cellsCacheDirectory } from './scripts/cache.js';
import { withCellSourceSnapshots } from './git.js';
import { readPlan } from './scripts/plan.js';
import { unplanned } from './scripts/plan.js';
import { stalePlanRows } from './scripts/plan.js';
import { entryPlacementProblems } from './plan/cuts.js';
import { ownedStayProblems } from './plan/cuts.js';

/** Parse immutable tree metadata, retaining symlinks and gitlinks as nonregular entries. */
function entriesAt(root, commit) {
  const listed = git(root, ['ls-tree', '-r', '-z', commit], { maxBuffer: 64 * 1024 ** 2, env: cellGitEnvironment(root) ?? gitChildEnv(root) });
  const entries = new Map();
  for (const row of listed.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/u.exec(row);
    if (!match || match[3].split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid committed cells tree entry');
    entries.set(match[3], { mode: match[1], object: match[2] });
  }
  return entries;
}

/** Hold the baseline bytes in memory and read only candidate paths whose immutable object changed. */
export function cellsObjectSnapshots(root, acceptedMain, commits, artifact, onRead = () => {}) {
  const mainEntries = entriesAt(root, acceptedMain);
  const snapshots = new Map();
  for (const commit of new Set([acceptedMain, ...commits])) {
    const files = new Map(artifact.inventory.files);
    const entries = commit === acceptedMain ? mainEntries : entriesAt(root, commit);
    const changed = commit === acceptedMain ? [] : git(root, ['diff', '--name-only', '--no-renames', '-z', acceptedMain, commit], { env: cellGitEnvironment(root) ?? gitChildEnv(root) }).split('\0').filter(Boolean);
    for (const file of changed) {
      const entry = entries.get(file);
      if (!entry || !/^100(?:644|755)$/u.test(entry.mode)) { files.delete(file); continue; }
      const bytes = gitExecFileSync(['--no-replace-objects', 'cat-file', 'blob', entry.object], {
        cwd: root, env: cellGitEnvironment(root) ?? gitChildEnv(root), encoding: null, maxBuffer: 64 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'],
      });
      files.set(file, bytes);
      onRead(file, commit);
    }
    const virtualRoot = join(cellsCacheDirectory('snapshots'), commit);
    snapshots.set(commit, { root: virtualRoot, repoRoot: root, commit, files, entries });
  }
  return snapshots;
}

/**
 * Read the commit's tree as Git objects: every entry's mode and object id, and the bytes of each regular source or
 * JSON blob in one `cat-file --batch` stream. No file is written and no worktree is added.
 * @param {string} root A checkout of the repository.
 * @param {string} commit The commit about to be recorded as merged.
 * @param {NodeJS.ProcessEnv} env A clean Git environment.
 * @returns {{ root: string, repoRoot: string, commit: string, files: Map<string, Buffer>, entries: Map<string, { mode: string, object: string }> }}
 */
function objectSnapshot(root, commit, env) {
  const listed = git(root, ['ls-tree', '-r', '-z', commit], { maxBuffer: 64 * 1024 ** 2, env });
  const entries = new Map(), wanted = [];
  for (const row of listed.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/u.exec(row);
    if (!match) continue;
    entries.set(match[3], { mode: match[1], object: match[2] });
    if (/^100(?:644|755)$/u.test(match[1]) && /\.(?:[cm]?js|json)$/u.test(match[3])) wanted.push(match[3]);
  }
  const blobs = wanted.length ? gitExecFileSync(['cat-file', '--batch'], {
    cwd: root, env, input: `${wanted.map(file => entries.get(file).object).join('\n')}\n`, encoding: null, maxBuffer: 256 * 1024 ** 2,
  }) : Buffer.alloc(0);
  const files = new Map();
  let at = 0;
  for (const file of wanted) {
    const end = blobs.indexOf(0x0a, at);
    const header = end < 0 ? [] : blobs.toString('utf8', at, end).split(' ');
    if (header[1] !== 'blob') throw new Error(`could not read ${file}`);
    const size = Number(header[2]);
    files.set(file, blobs.subarray(end + 1, end + 1 + size));
    at = end + 1 + size + 1;
  }
  return { root: join(tmpdir(), 'pullboard-landing-plan-objects', commit), repoRoot: root, commit, files, entries };
}

/**
 * Run the plan check's own logic (unplaced paths, stale rows, entry and owned-stay rules) on a commit's plan and
 * paths read from Git objects, returning the same lines `packages/codemap/src/io/cells/scripts/plan.js --check` prints.
 * @param {ReturnType<typeof objectSnapshot>} snapshot The commit's tree as Git objects.
 * @returns {{ unplaced: string[], lines: string[] }} Unplaced paths, and the other failure lines.
 */
function planProblems(snapshot) {
  try {
    return withCellSourceSnapshots([snapshot], () => {
      const plan = readPlan(snapshot.root);
      const missing = unplanned(snapshot.root, plan), stale = stalePlanRows(snapshot.root, plan);
      const entries = [...entryPlacementProblems(snapshot.root, plan, snapshot.files), ...ownedStayProblems(plan)];
      return { unplaced: missing, lines: [...stale.map(({ file, row }) => `stale plan row in ${file}: ${row[0]} no longer exists; retire it: node packages/codemap/src/io/cells/scripts/plan.js --retire ${row[0]}`), ...entries] };
    });
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('CELLS_')) return { unplaced: [], lines: [`${error.code}: ${error.message}`] };
    throw error;
  }
}

/**
 * Whether a commit's own plan is a Pullboard cells plan, and if so every placement problem it has, found from Git objects.
 * @param {string} root A checkout of the repository.
 * @param {string} commit The commit about to be recorded as merged.
 * @param {NodeJS.ProcessEnv} env A clean Git environment.
 * @returns {{ unplaced: string[], lines: string[] }|null} The problems, or null when the commit's plan is another tool's.
 */
export function landingPlanProblems(root, commit, env) {
  let index;
  try { index = JSON.parse(git(root, ['show', `${commit}:packages/codemap/data/plan/cells.json`], { maxBuffer: 64 * 1024 ** 2, env })); } catch { return null; }
  return Array.isArray(index?.cells) ? planProblems(objectSnapshot(root, commit, env)) : null;
}
