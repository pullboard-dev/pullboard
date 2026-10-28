#!/usr/bin/env node
/** Apply one explicit leaf move, or reverse its exact uncommitted transaction [C7]. */
import { resolve } from 'node:path';
import { cellsMove } from './cells-move-tool.js';
import { Refused } from '../src/refused.js';

try {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === '--undo' && args.length === 1) {
    cellsMove.undo(resolve(args[0]));
    console.log('Restored the exact pre-move checkout.');
  } else if (mode === '--apply' && args.length === 5) {
    const [from, to, frontDoor, purpose, custody] = args;
    const plan = cellsMove.plan({ root: process.cwd(), from, to, frontDoor, purpose });
    console.log(JSON.stringify(cellsMove.apply(plan, resolve(custody)), null, 2));
  } else {
    throw new Refused('CELLS_MOVE', 'Use --apply <old> <body> <front-door> <purpose> <existing-external-custody-dir> or --undo <record>.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
