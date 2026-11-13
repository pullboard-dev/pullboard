/** @pullboard-test-loads packages/seats/index.js src/commands/join.js src/commands/shout.js src/commands/next.js */
/** Real executable wake delivery, native routing and machine-local relay isolation [C7]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../../../lib/index.js';
import {
  closeBoard,
  agentById,
  boardId,
  heartbeatSeat,
  exportBoard,
  importBoard,
  importSeatObservations,
  mainRedBuildRouting,
  SEAT_LIVE_WINDOW_MS,
} from '../../../../packages/store/index.js';
import { wakeRoutedSeat } from '../../../../packages/seats/index.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { captureCommandInProcess } from '../../tests/fixtures/process.js';
import { main } from '../../tests/fixtures/native.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

/** Register through the actual join command; the executable records its literal argument vector. */
async function wakeFixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const output = join(box.dir, 'wakes.jsonl');
  const command = join(box.dir, 'wake;literal-command');
  writeFileSync(command, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  chmodSync(command, 0o755);
  const seatRoot = join(box.dir, 'idle-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'api/wake', seatRoot);
  const joined = await fixtureJoin(box.runIn, seatRoot, 'api', '--wake', command, '--json');
  assert.equal(joined.code, 0, joined.err + joined.out);
  const seat = JSON.parse(joined.out).agent;
  let at = Date.now();
  const clock = { now: () => new Date(at) };
  // @pullboard-board-file journey: reads the board the CLI children wrote
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), clock);
  t.after(() => closeBoard(board));
  heartbeatSeat(board, seat);
  const added = await fixtureAdd(box.runIn, box.repo, 'api', 'Wake the routed seat', '--specs', 'G2', '--criterion', 'The wake receives this item.', '--check', 'test -f api/wake-ready', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const item = JSON.parse(added.out).item.item_id;
  /** Execute the real CLI with this fixture's deterministic presence clock. */
  const cli = argv => captureCommandInProcess((args, streams) => main(args, { ...streams, clock }), argv, { cwd: box.repo, env: box.env });
  return { ...box, board, seat, seatRoot, item, command, output, clock, cli,
    idle() { at += SEAT_LIVE_WINDOW_MS; },
    wakes() { return existsSync(output) ? readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []; } };
}

test('coordinator and board routing deliver one literal item argument to an idle local seat [C7]', async t => {
  const box = await wakeFixture(t);
  assert.equal(agentById(box.board, box.seat).presence, 'live');
  const live = await box.cli(['shout', box.seat, `take #${box.item}`]);
  assert.equal(live.code, 0, live.err + live.out);
  assert.deepEqual(box.wakes(), [], 'a live session is not woken');
  box.idle();
  assert.equal(agentById(box.board, box.seat).presence, 'idle');
  const routed = await box.cli(['shout', box.seat, `build #${box.item}`]);
  assert.equal(routed.code, 0, routed.err + routed.out);
  assert.deepEqual(box.wakes(), [[String(box.item)]], 'the completed command delivered the id once, without shell parsing the executable name');
  const plan = mainRedBuildRouting(box.board, { priority: [box.item], caller: 'coordinator' });
  assert.equal(plan.buildOffer.seat, box.seat);
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  try {
    const wake = await wakeRoutedSeat(repoInfo(box.repo), { boardId: boardId(box.board), seat: plan.seat, item: plan.item.item_id });
    assert.equal(wake.woke, true);
  } finally { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; }
  assert.deepEqual(box.wakes(), [[String(box.item)], [String(box.item)]], 'each routed event executes once');
});

test('a relayed seat cannot carry an executable wake capability onto another machine [C7]', async t => {
  const box = await wakeFixture(t);
  box.idle();
  const snapshot = exportBoard(box.board);
  assert.equal(JSON.stringify(snapshot).includes(box.command), false, 'the command never enters shared board state');
  const receiver = openBoard(':memory:', box.clock);
  t.after(() => closeBoard(receiver));
  importBoard(receiver, snapshot);
  importSeatObservations(receiver, [{ agent_id: box.seat, heartbeatAt: agentById(box.board, box.seat).heartbeatAt }]);
  const seat = { ...agentById(receiver, box.seat), wake: box.command, agent_wake: box.command };
  assert.equal(seat.presence, 'idle', 'the imported display observation cannot grant local execution authority');
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(box.dir, 'receiving-machine');
  try {
    const wake = await wakeRoutedSeat(repoInfo(box.repo), { boardId: boardId(receiver), seat, item: box.item });
    assert.equal(wake.woke, false, 'even a remote payload naming a real executable is not a local registration');
  } finally { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; }
  assert.deepEqual(box.wakes(), [], 'the remote seat command never ran');
});
