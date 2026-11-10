#!/usr/bin/env node
/** Apply one explicit leaf move, or reverse its exact uncommitted transaction [C7]. */
import { recordToolCommand } from '../../../../git/index.js';
import { resolve } from 'node:path';
import { cellsMove } from './move/tool.js';
import { Refused } from '../../../../kernel/index.js';

try {
  const [mode, ...args] = process.argv.slice(2);
  const keep = args.at(-1)?.startsWith('--keep-exports=') ? args.pop().slice('--keep-exports='.length).split(',') : null;
  if (mode === '--undo' && args.length === 1 && keep === null) {
    cellsMove.undo(resolve(args[0]));
    console.log('Restored the exact pre-move checkout.');
  } else if (mode === '--apply' && args.length === 5) {
    const [from, to, frontDoor, purpose, custody] = args;
    const plan = cellsMove.plan({ root: process.cwd(), from, to, frontDoor, purpose, keepExports: keep });
    const result = recordToolCommand(process.cwd(), { tool: 'cells-move', from, to, frontDoor, purpose, keepExports: keep }, () => cellsMove.apply(plan, resolve(custody)));
    console.log(JSON.stringify(result, null, 2));
  } else {
    throw new Refused('CELLS_MOVE', 'Use --apply <old> <body> <front-door> <purpose> <existing-external-custody-dir> [--keep-exports=name,...] or --undo <record>.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
