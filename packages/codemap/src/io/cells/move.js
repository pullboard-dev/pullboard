#!/usr/bin/env node
/** Apply one explicit leaf move, or reverse its exact uncommitted transaction [C7]. */
import { recordToolCommand } from '../../../../git/index.js';
import { resolve } from 'node:path';
import { cellsMove } from './move/tool.js';
import { rewriteMovedBars } from './move/bars.js';
import { spawnSync } from 'node:child_process';
import { Refused } from '../../../../kernel/index.js';
import { loadConfig } from '../../../../config/index.js';
import { moveAfterRowRewrite } from './move/rows.js';

/** The verify.requireRowRewrite setting of this repository; a directory with no pullboard.json has none, so it is off. */
function rowRewriteEnabled(root) {
  try { return loadConfig(root).verify?.requireRowRewrite === true; }
  catch (error) { if (error?.code === 'NO_CONFIG') return false; throw error; }
}

try {
  const [mode, ...args] = process.argv.slice(2);
  // --rewrite-bars=<reason>: every open bar naming the moved path is rewritten through pullboard edit, with this reason [B4,R2].
  const reason = args.at(-1)?.startsWith('--rewrite-bars=') ? args.pop().slice('--rewrite-bars='.length) : null;
  const keep = args.at(-1)?.startsWith('--keep-exports=') ? args.pop().slice('--keep-exports='.length).split(',') : null;
  if (mode === '--undo' && args.length === 1 && keep === null) {
    cellsMove.undo(resolve(args[0]));
    console.log('Restored the exact pre-move checkout.');
  } else if (mode === '--apply' && args.length === 5) {
    const [from, to, frontDoor, purpose, custody] = args;
    // The app passes its command in through PULLBOARD_CLI (a node entry file), else the pullboard on the PATH runs.
    const entry = process.env.PULLBOARD_CLI;
    const run = pullboard => spawnSync(entry ? process.execPath : 'pullboard', [...(entry ? [entry] : []), ...pullboard], { cwd: process.cwd(), encoding: 'utf8' });
    // A cited spec row whose text changed with no rewrite edit refuses before anything is planned or moved [B4,R2,#5704].
    const result = moveAfterRowRewrite({ run, enabled: rowRewriteEnabled(process.cwd()) }, () => {
      const plan = cellsMove.plan({ root: process.cwd(), from, to, frontDoor, purpose, keepExports: keep });
      return recordToolCommand(process.cwd(), { tool: 'cells-move', from, to, frontDoor, purpose, keepExports: keep }, () => cellsMove.apply(plan, resolve(custody)));
    });
    console.log(JSON.stringify(result, null, 2));
    if (reason !== null) {
      console.log(JSON.stringify({ rewrittenBars: rewriteMovedBars({ moves: [{ from, to }], reason, run }) }, null, 2));
    }
  } else {
    throw new Refused('CELLS_MOVE', 'Use --apply <old> <body> <front-door> <purpose> <existing-external-custody-dir> [--keep-exports=name,...] or --undo <record>.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
