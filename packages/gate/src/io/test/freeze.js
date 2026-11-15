/** The freeze script: move, convert or delete test files from the manifest's tags in one change, and record every move [C7]. */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { git } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';
import { countActions } from '../../logic/test/freeze.js';
import { planFreeze } from '../../logic/test/freeze.js';
import { rebaseSpecifiers } from '../../logic/test/freeze.js';
import { idRenames } from './ids.js';
import { testIdIndex } from './ids.js';
import { ORDER as ORDER_FILE } from './cells.js';
import { TEST_JOURNEYS_FILE as JOURNEYS_FILE } from './derived.js';
import { TEST_MANIFEST_FILE } from './manifest.js';

export const FREEZE_RECORD_FILE = 'packages/gate/data/tests/freeze-moves.json';

/** Read a JSON file under the root, or the fallback when it is absent. */
function readJson(root, file, fallback) {
  const path = join(root, file);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

/**
 * The owning cell of a test file: the cell it already sits in, else the lowest-order real cell its listing names, else the app that holds its journeys folder.
 * Why: the journeys listing already records which cells each journey reaches, and cell-order.json says which is lowest, so no owner is guessed.
 *
 * @param {string} root project root
 * @returns {(file: string) => string|null} resolver
 */
export function cellOwner(root) {
  const order = readJson(root, ORDER_FILE, { order: [] }).order;
  const listed = readJson(root, JOURNEYS_FILE, { files: {} }).files;
  const folder = name => [`packages/${name}`, `apps/${name}`].find(dir => existsSync(join(root, dir)));
  return file => {
    const inside = /^((?:packages|apps)\/[^/]+)\/(?:tests?|journeys)\//u.exec(file)?.[1];
    if (inside && /\/tests?\//u.test(file)) return inside;
    const cells = (listed[file]?.cells ?? []).filter(name => !name.includes(':') && folder(name))
      .sort((a, b) => (order.indexOf(a) < 0 ? 1e9 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 1e9 : order.indexOf(b)));
    return cells.length ? folder(cells[0]) : inside ?? null;
  };
}

/**
 * Plan the freeze from a manifest file, touching nothing.
 *
 * @param {string} root project root
 * @param {{ manifest?: string, owner?: (file: string) => string|null }} [options] manifest path under root; owner resolver for tests
 * @returns {{ plan: object[], counts: Record<string, number> }}
 */
export function planFreezeAt(root, { manifest = TEST_MANIFEST_FILE, owner = cellOwner(root) } = {}) {
  const path = resolve(root, manifest);
  if (!existsSync(path)) throw new Refused('FREEZE_NO_MANIFEST', `no test manifest at ${manifest}`, 'run node packages/gate/src/io/test/scripts/manifest.js first');
  const rows = JSON.parse(readFileSync(path, 'utf8')).files;
  const tracked = new Set(git(root, ['ls-files', '-z']).split('\0').filter(Boolean));
  const plan = planFreeze(rows.filter(row => tracked.has(row.file)), { owner, taken: tracked });
  return { plan, counts: countActions(plan) };
}

/**
 * Apply the plan with git, so history follows each move, and record old and new paths.
 * Why: one scripted change is the Cells lesson; `git mv` and `git rm` stage it as one change for a single commit, and the ID index before and after proves stable test IDs followed every move.
 *
 * @param {string} root project root
 * @param {object[]} plan from planFreeze
 * @returns {{ moved: object[], deleted: object[], lostIds: string[] }} what was done; IDs no test carries after the change
 */
export function applyFreeze(root, plan) {
  const before = testIdIndex(root);
  const moved = [], deleted = [];
  for (const change of plan) {
    if (change.action === 'delete') {
      git(root, ['rm', '-q', '--', change.file]);
      deleted.push({ file: change.file, coveredBy: change.coveredBy, because: change.because });
    } else if (change.action === 'move' || change.action === 'convert') {
      mkdirSync(dirname(join(root, change.to)), { recursive: true });
      git(root, ['mv', '--', change.file, change.to]);
      const path = join(root, change.to), source = readFileSync(path, 'utf8'), rebased = rebaseSpecifiers(source, change.file, change.to);
      if (rebased !== source) writeFileSync(path, rebased);
      moved.push({ from: change.file, to: change.to, action: change.action, because: change.because });
    }
  }
  const after = testIdIndex(root);
  const followed = idRenames(before, after);
  const lostIds = [...before.byId.keys()].filter(id => !after.byId.has(id)
    && !deleted.some(entry => before.byId.get(id) === entry.file));
  for (const entry of moved) entry.idsFollowed = followed.get(entry.from) === entry.to || !before.byFile.has(entry.from);
  mkdirSync(dirname(join(root, FREEZE_RECORD_FILE)), { recursive: true });
  writeFileSync(join(root, FREEZE_RECORD_FILE), `${JSON.stringify({ version: 1, moved, deleted }, null, 2)}\n`);
  git(root, ['add', '--', FREEZE_RECORD_FILE]);
  return { moved, deleted, lostIds };
}

/**
 * The freeze command: `[--dry-run] [--manifest file] [project-root]`. A dry run prints every planned change and the count per action and touches no file.
 * Why: the script runs once, in the freeze window; the dry run is the review before it.
 *
 * @param {string[]} args command arguments
 * @param {{ owner?: Function }} [options] owner resolver, for tests
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function runFreezeCommand(args, { owner } = {}) {
  const at = args.indexOf('--manifest');
  const manifest = at >= 0 ? args[at + 1] : TEST_MANIFEST_FILE;
  const rest = args.filter((arg, index) => arg !== '--dry-run' && at < 0 || (index !== at && index !== at + 1));
  if (rest.some(arg => arg.startsWith('-')) || rest.length > 1 || (at >= 0 && !manifest)) {
    return { status: 1, stdout: '', stderr: 'usage: node packages/gate/src/io/test/scripts/freeze.js [--dry-run] [--manifest file] [project-root]\n' };
  }
  const root = resolve(rest[0] ?? '.');
  const dry = args.includes('--dry-run');
  let planned;
  try { planned = planFreezeAt(root, { manifest, ...(owner ? { owner } : {}) }); } catch (error) {
    if (error instanceof Refused) return { status: 1, stdout: '', stderr: `${error.message}\nnext: ${error.next}\n` };
    throw error;
  }
  const { plan, counts } = planned;
  const lines = plan.filter(change => change.action !== 'in place').map(change => {
    const target = change.action === 'delete' ? `covered by ${change.coveredBy.join(', ')}` : change.to ? `-> ${change.to}` : `(${change.because})`;
    return `${dry ? 'would ' : ''}${change.action}: ${change.file} ${target}`;
  });
  const summary = `${dry ? 'dry run: ' : ''}${Object.entries(counts).map(([action, count]) => `${count} ${action}`).join(', ')}\n`;
  if (dry) return { status: 0, stdout: `${lines.join('\n')}${lines.length ? '\n' : ''}${summary}`, stderr: '' };
  const { lostIds } = applyFreeze(root, plan);
  if (lostIds.length) return { status: 1, stdout: `${lines.join('\n')}\n${summary}`, stderr: `${lostIds.length} stable test IDs lost their test: ${lostIds.join(', ')}\nnext: git restore --staged --worktree . and fix the plan\n` };
  return { status: 0, stdout: `${lines.join('\n')}${lines.length ? '\n' : ''}${summary}recorded in ${FREEZE_RECORD_FILE}\n`, stderr: '' };
}
