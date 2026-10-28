#!/usr/bin/env node
/** Report remaining Git launch sites with --report, or refuse per-file growth during migration [C7]. */
import {
  readFileSync,
  realpathSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gitLaunchGrowth,
  gitLaunchReport,
} from '../../src/git-launch-ratchet.js';
import { report } from './scan.js';

/** Find additions against the committed baseline, retaining the remaining sites as an explicit report. */
export function gitLaunchProblems(root) {
  const baseline = JSON.parse(readFileSync(new URL('../../packages/git/src/shell/git-launch-baseline.json', import.meta.url), 'utf8'));
  return gitLaunchGrowth(gitLaunchReport(root), baseline.files).map(problem => ({
    path: problem.file, line: 1,
    text: `${problem.actual} direct Git launches exceeds the ratchet allowance ${problem.allowed}; use the Git adapter`,
  }));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const root = resolve(process.argv.slice(2).find(argument => argument !== '--report') ?? '.');
  if (process.argv.includes('--report')) console.log(JSON.stringify(gitLaunchReport(root), null, 2));
  else report(gitLaunchProblems(root));
}
