/** run --scale launches exactly one seat for one open item, with its io intact and no Git-read error [C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../../../tests/fixtures/e2e.js';
import { onBoard } from '../../../../tests/fixtures/land/board.js';
import { runFixtureChild } from '../../../../tests/fixtures/child.js';

/** Quote a private fixture path for the supervisor's shell command. */
function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

test('clause 1: run --scale with a fake agent launches exactly one seat in its own worktree and reports no error [C7]', { timeout: 120_000 }, t => { // budget: one native scaler cycle and private Git registration, not a throughput assertion.
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_MODEL = 'Scaler fixture';
  const box = helpers.project('true', isolated, { withWorktree: false });
  const records = join(box.dir, 'agent-records.jsonl');
  const script = join(box.dir, 'fake-agent.cjs');
  writeFileSync(records, '');
  writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(records)}, JSON.stringify({ root: process.cwd(), seat: process.env.PULLBOARD_SEAT }) + '\\n');\n`);
  onBoard(box, board => {
    store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Only open task', route: 'strong',
      criterion: 'the named fix works', check: 'true' });
  });
  const settings = box.run(box.repo, 'settings', 'workers.budget', '96/day');
  assert.equal(settings.code, 0, settings.err);
  const result = runFixtureChild(process.execPath, [join(import.meta.dirname, '../../../../pullboard.js'), 'run', '--scale', '--lane', 'web',
    '--model', 'Scaler fixture', '--route', 'strong', '--family', 'Scaler fixture vendor', '--agent', `${quote(process.execPath)} ${quote(script)}`,
    '--cycles', '1', '--every', '5'], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.doesNotMatch(result.stderr + result.stdout, /need a root and positive timeout/u, 'a launched seat keeps the caller cwd and env');
  const starts = readFileSync(records, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(starts.length, 1, `exactly one seat starts: ${result.stdout}`);
  assert.notEqual(resolve(starts[0].root), resolve(box.repo), 'the seat works in its own worktree, not the main checkout');
  const seats = onBoard(box, board => store.listAgents(board).filter(seat => seat.agent_lane === 'web'));
  assert.equal(seats.length, 1, 'one seat is registered on the board');
});
