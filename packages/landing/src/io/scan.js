/** The scans of a named landing that used to run on the coordinator: module resolution and cells-plan placement, now one runner job [C7,#5559]. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { landingPlacementProblems } from './guards.js';
import { requireLandingModuleResolution } from './guards.js';

/** Printed instead of rows when this checkout lacks the batch's objects, so the coordinator scans locally. */
export const SCAN_UNAVAILABLE = 'LANDING_SCAN_UNAVAILABLE';

const SCAN_PATH = 'packages/landing/src/io/scan.js';

/** Whether this named batch's scans ride the runner job: only where the project carries this script and has a static command to chain it to. */
export function scanRidesRunner(state) {
  return state.batch.external === true && Boolean(state.config.staticChecks?.trim()) && existsSync(join(state.batch.root, SCAN_PATH));
}

const PLAN = 'packages/codemap/data/plan/cells.json';

/** The `file:line: text` rows the static-check reader attributes to items, from a module-resolution refusal. */
function resolutionRows(error) {
  if (error.code === 'LAND_MODULE_PARSE') return (error.broken?.length ? error.broken : ['(composed tree)']).map(file => `${file}:1: ${error.code} ${error.message}`);
  if (error.code === 'LANDING_SECRET') return error.found.map(where => `${where.slice(where.lastIndexOf(' at ') + 4)}: ${error.code} ${where.slice(0, where.lastIndexOf(' at '))}`);
  if (error.code !== 'LAND_MODULE_RESOLUTION') throw error;
  const listed = error.message.replace(/^[^:]*targets: /u, '').replace(/; restore or repoint.*$/u, '');
  return listed.split('; ').map(part => `${part.split(': ')[0]}:1: ${error.code} ${part}`);
}

/**
 * Scan the composed tree at `tip` against `base`; resolves rows (empty when clean) or SCAN_UNAVAILABLE.
 * Why: the parse, the import graph of two whole trees and the plan check cost the coordinator seconds of CPU per landing; a runner has the spare CPU.
 */
export async function scanLanding(root, base, tip) {
  const have = sha => tryGit(root, ['cat-file', '-e', `${sha}^{commit}`]).status === 0;
  if (!have(base) || !have(tip) || git(root, ['rev-parse', 'HEAD^{tree}']) !== git(root, ['rev-parse', `${tip}^{tree}`])) return SCAN_UNAVAILABLE;
  const rows = [];
  try { await requireLandingModuleResolution(root, base, tip); } catch (error) { rows.push(...resolutionRows(error)); }
  if (existsSync(join(root, PLAN)) && tryGit(root, ['cat-file', '-e', `${base}:${PLAN}`]).status === 0) {
    const problems = await landingPlacementProblems(root, base);
    for (const row of problems) rows.push(`${row.path}:1: CELLS_PLAN_UNPLACED ${row.message}; place it with node packages/codemap/src/io/cells/scripts/plan.js --place <path> --cell <cell> (or --stay)`);
  }
  return rows;
}

/** Run as a runner job: print the rows, exit 1 when any; no top-level await so require() can load this module. */
async function main() {
  const flag = name => process.argv[process.argv.indexOf(name) + 1];
  const result = await scanLanding(process.cwd(), flag('--base'), flag('--tip'));
  if (result === SCAN_UNAVAILABLE) process.stdout.write(`${SCAN_UNAVAILABLE}\n`);
  else {
    for (const row of result) process.stdout.write(`${row}\n`);
    process.exitCode = result.length ? 1 : 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
