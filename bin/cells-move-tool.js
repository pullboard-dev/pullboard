/** Bind the bounded leaf transaction to the repository's compile-only source analyzers [C7]. */
import { createMoveTool } from './cells-move-transaction.js';
import { lex } from '../packages/kernel/index.js';
import { importsIn } from '../src/module-imports.js';
import { commonJsIn } from '../src/module-imports.js';
import { engineFolderViolations } from '../src/engine-folder.js';
import { readPathMap } from '../packages/codemap/index.js';
import { cleanGitEnvironment } from '../src/git.js';
import { fixtureSourceEdits } from './cells-move-fixtures.js';

export const cellsMove = createMoveTool({
  lex,
  importsIn,
  commonJsIn,
  engineFolderViolations,
  readPathMap,
  cleanGitEnvironment,
  fixtureSourceEdits,
});
