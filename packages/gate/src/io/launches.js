#!/usr/bin/env node
/** Report remaining Git launch sites with --report, lower the allowance with --write, or refuse per-file growth [C7]. */
import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gitLaunchGrowth,
  gitLaunchReport,
  loweredGitLaunchBaseline,
} from '../../../git/index.js';
import { report } from './scan.js';

const BASELINE = new URL('../../../git/src/io/launch/baseline.json', import.meta.url);

/** Describe per-file growth as scan problems that name the next step. */
function growthProblems(growth) {
  return growth.map(problem => ({
    path: problem.file, line: 1,
    text: `${problem.actual} direct Git launches exceeds the ratchet allowance ${problem.allowed}; use the Git adapter`,
  }));
}

/** Find additions against the committed baseline, retaining the remaining sites as an explicit report. */
export function gitLaunchProblems(root) {
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  return growthProblems(gitLaunchGrowth(gitLaunchReport(root), baseline.files));
}

/** Record the lowered allowance after a migration; growth is reported and nothing is written. */
export function writeGitLaunchBaseline(root) {
  const lowered = loweredGitLaunchBaseline(gitLaunchReport(root), JSON.parse(readFileSync(BASELINE, 'utf8')));
  if (lowered.baseline) writeFileSync(BASELINE, `${JSON.stringify(lowered.baseline, null, 2)}\n`);
  return growthProblems(lowered.growth);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const root = resolve(process.argv.slice(2).find(argument => !['--report', '--write'].includes(argument)) ?? '.');
  if (process.argv.includes('--report')) console.log(JSON.stringify(gitLaunchReport(root), null, 2));
  else if (process.argv.includes('--write')) report(writeGitLaunchBaseline(root));
  else report(gitLaunchProblems(root));
}
