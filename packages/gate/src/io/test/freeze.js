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
import { countActions } from './freeze/plan.js';
import { planFreeze } from './freeze/plan.js';
import { rebaseSpecifiers } from './freeze/plan.js';
import { rebasePathMath } from './freeze/paths.js';
import { idRenames } from './ids.js';
import { testIdIndex } from './ids.js';
import { ORDER as ORDER_FILE } from './cells.js';
import { TEST_JOURNEYS_FILE as JOURNEYS_FILE } from './derived.js';
import { TEST_MANIFEST_FILE } from './manifest.js';

export const FREEZE_RECORD_FILE = 'packages/gate/data/tests/freeze-moves.json';

/** The generated move-table test that now proves each move's rules, by the journeys folder it replaced [C7,#8744]. */
export const GENERATED_MOVE_TESTS = Object.freeze({
  release: 'packages/moves/tests/logic/table/release-generated.test.js',
  claim: 'packages/moves/tests/logic/table/claim-generated.test.js',
  submit: 'packages/moves/tests/logic/table/submit-generated.test.js',
  verify: 'packages/moves/tests/logic/table/verify-generated.test.js',
  land: 'packages/moves/tests/logic/table/landing-generated.test.js',
});

/**
 * The generated move-table test that stands in for a deleted journey, or null when its folder is not a release, claim, submit, verify or landing journey.
 * Why: the record must name what replaced a deletion, so a reader can find the proof without searching.
 *
 * @param {string} file the deleted journey's path
 * @returns {string|null}
 */
export function generatedTestFor(file) {
  const folder = /^apps\/cli\/journeys\/([^/]+)\//u.exec(file)?.[1];
  return folder && Object.hasOwn(GENERATED_MOVE_TESTS, folder) ? GENERATED_MOVE_TESTS[folder] : null;
}

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
 * Refuse each move whose path math (new URL, join or resolve on its own folder) would not resolve after the move, naming file and line.
 * Why: a moved test that reads fixtures by a path computed from its own location breaks silently, so the dry run must say so before the freeze.
 *
 * @param {string} root project root
 * @param {object[]} plan from planFreeze
 * @returns {object[]} the plan with those moves turned into refusals
 */
function refusePathMath(root, plan) {
  const leaving = new Set(plan.filter(change => ['delete', 'move', 'convert'].includes(change.action)).map(change => change.file));
  const exists = path => !leaving.has(path) && existsSync(join(root, path));
  return plan.map(change => {
    if (change.action !== 'move' && change.action !== 'convert') return change;
    const { problems } = rebasePathMath(readFileSync(join(root, change.file), 'utf8'), change.file, change.to, exists);
    if (!problems.length) return change;
    const named = problems.map(problem => `${change.file}:${problem.line} ${problem.because}`).join('; ');
    return { file: change.file, tag: change.tag, action: 'refused', because: `path math cannot be rewritten: ${named}` };
  });
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
  const plan = refusePathMath(root, planFreeze(rows.filter(row => tracked.has(row.file)), { owner, taken: tracked }));
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
      // The covering files are counted, not listed: a broad spec id is cited by hundreds of tests, so lists made the record 36 MB; the committed manifest rederives them.
      const generatedBy = generatedTestFor(change.file);
      deleted.push({ file: change.file, specs: change.specs ?? [], coveredBy: change.coveredBy.length, because: change.because, ...(generatedBy ? { generatedBy } : {}) });
    } else if (change.action === 'move' || change.action === 'convert') {
      mkdirSync(dirname(join(root, change.to)), { recursive: true });
      git(root, ['mv', '--', change.file, change.to]);
      const path = join(root, change.to), source = readFileSync(path, 'utf8'), rebased = rebasePathMath(rebaseSpecifiers(source, change.file, change.to), change.file, change.to, () => true).source;
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
  const rest = args.filter((arg, index) => arg !== '--dry-run' && (at < 0 || (index !== at && index !== at + 1)));
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
