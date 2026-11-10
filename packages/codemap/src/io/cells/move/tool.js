/** Bind the bounded leaf transaction to the repository's compile-only source analyzers [C7]. */
import { spawnSync } from 'node:child_process';
import { lex } from '../../../../../kernel/index.js';
import {
  commonJsIn,
  createMoveTool,
  fixtureSourceEdits,
  importsIn,
  readPathMap,
} from '../../../../index.js';
import { engineFolderViolations } from '../../../../../state/index.js';
import { cleanGitEnvironment } from '../../../../../git/index.js';

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
