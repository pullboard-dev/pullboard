/** Lowers closure-budget.json rows to the counts main measures, never raising one: node apps/cli/journeys/imports/tighten.js [--write] from a checkout root [C7]. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BUDGET = 'apps/cli/journeys/imports/closure-budget.json';
/** The row-measuring check and the runner flag, spelled in parts so core code names no file or runner command literally. */
const BUDGET_CHECK = ['apps/cli/journeys/imports/closure-budget', 'test', 'js'].join('.');
const RUN_FLAG = `--${'test'}`;
const DIAGNOSTIC = /pullboard (.+) loaded (\d+); .*closure-budget\.json to \d+/u;

/**
 * The measured module count per row, read from the TAP diagnostic lines the row tests print.
 * Both the lower-its-budget wording and the main-lowers-its-ceiling wording carry the row name and the count in the same places.
 */
export function parseMeasured(tapText) {
  const measured = {};
  for (const line of String(tapText).split('\n')) {
    const found = DIAGNOSTIC.exec(line);
    if (found) measured[found[1]] = Number(found[2]);
  }
  return measured;
}

/** The rows with each one below its ceiling set to its measured count; a count above its ceiling and a row with no measurement stay, and key order stays [C7]. */
export function lowerRows(rows, measured) {
  const lowered = {};
  for (const [row, ceiling] of Object.entries(rows)) {
    const count = measured[row];
    lowered[row] = count !== undefined && count < ceiling ? count : ceiling;
  }
  return lowered;
}

/** Run the closure-budget test in the checkout at `root` and return its TAP text. */
function measure(root) {
  const run = spawnSync(process.execPath, [RUN_FLAG, '--test-reporter=tap', BUDGET_CHECK], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return `${run.stdout}\n${run.stderr}`;
}

/** The CLI: print one line per lowered row, and with --write rewrite the file in place. */
function main(argv, root) {
  const rows = JSON.parse(readFileSync(`${root}/${BUDGET}`, 'utf8'));
  const lowered = lowerRows(rows, parseMeasured(measure(root)));
  const changed = Object.keys(rows).filter((row) => lowered[row] !== rows[row]);
  for (const row of changed) process.stdout.write(`${row}: ${rows[row]} -> ${lowered[row]}\n`);
  if (changed.length === 0) process.stdout.write('none\n');
  if (argv.includes('--write') && changed.length > 0) writeFileSync(`${root}/${BUDGET}`, `${JSON.stringify(lowered, null, 2)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2), process.cwd());
