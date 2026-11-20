/** Run the layout rules against the tracked tree and hold them to a baseline that only lowers [V32,V33]. */
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryGit } from '../../../git/index.js';
import { LAYOUT_RULES } from '../logic/layout.js';
import { layoutCounts } from '../logic/layout.js';
import { layoutRatchet } from '../logic/layout.js';
import { layoutViolations } from '../logic/layout.js';
import { fileSystemAdapter } from '../../../fs/index.js';
const disk = fileSystemAdapter();

/** The baseline's path from a checkout root, for a caller that judges another tree's own copy. */
export const LAYOUT_BASELINE = 'packages/codemap/data/baselines/layout.json';
const BASELINE = join(dirname(fileURLToPath(import.meta.url)), '../../data/baselines/layout.json');

/** A refusal in the house shape: the rule code leads the message and the next step rides along. */
function refused(code, message, next) {
  return Object.assign(new Error(`[${code}] ${message}`), { code, next });
}

/**
 * Every violation in the tree at `root`, from Git's tracked paths.
 *
 * @param {string} root A Git checkout.
 * @returns {{ rule: string, key: string, detail: string }[]}
 */
export function layoutReport(root) {
  const listed = tryGit(root, ['ls-files', '--cached', '-z']);
  if (listed.status !== 0) throw refused('LAYOUT_NO_GIT', 'the layout check reads tracked files from Git', 'run it inside a Git checkout');
  return layoutViolations(listed.stdout.split('\0').filter(Boolean));
}

/** The accepted counts, or null when no baseline exists yet. */
function readBaseline(file) {
  try { return JSON.parse(disk.readFile(file, 'utf8')); } catch { return null; }
}

/**
 * Refuse when any rule's count rose above the baseline; report the ones that fell.
 *
 * @param {string} root
 * @param {{ baselineFile?: string }} [options]
 * @returns {{ counts: Record<string, number>, lowered: string[] }}
 */
export function layoutCheck(root, { baselineFile = BASELINE } = {}) {
  const violations = layoutReport(root);
  const counts = layoutCounts(violations);
  const { problems, lowered } = layoutRatchet(counts, readBaseline(baselineFile), violations);
  if (problems.length) throw refused('LAYOUT_RATCHET', problems.join('\n'), 'move the offending files to the layout the rule names; a baseline never rises');
  return { counts, lowered };
}

/**
 * Write the baseline from today's tree; refused when any rule would rise above an existing baseline.
 *
 * @param {string} root
 * @param {{ baselineFile?: string }} [options]
 * @returns {Record<string, number>} The counts written.
 */
export function layoutWrite(root, { baselineFile = BASELINE } = {}) {
  const old = readBaseline(baselineFile);
  const { counts } = old ? layoutCheck(root, { baselineFile }) : { counts: layoutCounts(layoutReport(root)) };
  disk.mkdir(dirname(baselineFile), { recursive: true });
  disk.writeFile(baselineFile, `${JSON.stringify({ version: 1, rules: counts }, null, 2)}\n`);
  return counts;
}

/** Command line: --check (exit 1 when a count rose), --write (lower the baseline), --list (every finding). */
function main(argv) {
  const root = process.cwd();
  try {
    if (argv.includes('--list')) {
      for (const row of layoutReport(root)) console.log(`${row.rule}\t${row.detail}`);
    } else if (argv.includes('--write')) {
      console.log(JSON.stringify(layoutWrite(root)));
    } else if (argv.includes('--check')) {
      const { counts, lowered } = layoutCheck(root);
      for (const line of lowered) console.log(line);
      console.log(`layout: ${Object.values(counts).reduce((sum, n) => sum + n, 0)} violations, none above the baseline`);
    } else {
      const counts = layoutCounts(layoutReport(root));
      for (const rule of Object.keys(LAYOUT_RULES)) console.log(`${String(counts[rule]).padStart(6)}  ${rule}  ${LAYOUT_RULES[rule]}`);
    }
  } catch (error) {
    if (!error.next) throw error;
    console.error(`${error.message}\nnext: ${error.next}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
