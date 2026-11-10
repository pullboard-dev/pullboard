/** @pullboard-world-pin: the harness reads packages/gate/data/ceilings/board-commands.json of the tree under test, the ceilings the main audit holds. */
/**
 * The board-command budget on demand, the same check the periodic main audit runs [C7]: on a fixture board, each seat
 * command (next, show, claim, status, whoami, inbox) loads no more modules than its ceiling in
 * packages/gate/data/ceilings/board-commands.json and answers in a median under 200 ms through the warm resident process.
 * `node packages/gate/src/io/matrix.js --only board-commands` runs it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ROOT,
  from,
  guardProcesses,
  hopCheck,
  scratch,
  within,
} from '../kit.js';

guardProcesses();

test('each seat command stays under its module ceiling and answers in under 200 ms warm [C7]', { timeout: 600_000 }, async () => {
  const { budgetBreaches, measureBoardCommands, WALL_MS } = await from('apps/cli/src/io/landing/budget.js');
  const committed = JSON.parse(readFileSync(join(ROOT, 'packages/gate/data/ceilings/board-commands.json'), 'utf8'));
  const dir = await scratch('board-commands');
  await hopCheck('command-latency', async () => {
    const measured = await measureBoardCommands(ROOT, dir);
    const breaches = budgetBreaches(measured, committed.modules, { wallMs: committed.wallMs ?? WALL_MS });
    const slowest = Math.max(...Object.values(measured).map(row => row.medianMs));
    const result = { ms: slowest, measured: Object.entries(measured).map(([name, row]) => `${name} ${row.modules} modules ${row.medianMs} ms`).join(', ') };
    within(!breaches.length, breaches.map(breach => `${breach.command} ${breach.kind} ${breach.value} over ${breach.ceiling}`).join('; '), result);
    return result;
  });
});
