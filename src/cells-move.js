/** Bind the bounded leaf transaction to the repository's compile-only source analyzers [C7]. */
import { createMoveTool } from './cells-move-transaction.js';
import { lex } from './js-lex.js';
import { importsIn } from './module-imports.js';
import { commonJsIn } from './module-imports.js';
import { engineFolderViolations } from './engine-folder.js';
import { readPathMap } from './path-map.js';
import { cleanGitEnvironment } from './git.js';

export const cellsMove = createMoveTool({
  lex,
  importsIn,
  commonJsIn,
  engineFolderViolations,
  readPathMap,
  cleanGitEnvironment,
});
