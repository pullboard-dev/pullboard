/** Bind the bounded leaf transaction to the repository's compile-only source analyzers [C7]. */
import { spawnSync } from 'node:child_process';
import { lex } from '../packages/kernel/index.js';
import { commonJsIn, createMoveTool, fixtureSourceEdits, importsIn, readPathMap } from '../packages/codemap/index.js';
import { engineFolderViolations } from '../packages/state/index.js';
import { cleanGitEnvironment } from '../packages/git/index.js';

export const cellsMove = createMoveTool({
  lex,
  importsIn,
  commonJsIn,
  engineFolderViolations,
  readPathMap,
  cleanGitEnvironment,
  fixtureSourceEdits,
  runProcess: spawnSync,
});
