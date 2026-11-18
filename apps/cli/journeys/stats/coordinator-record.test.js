/** stats.recordCoordinatorUsage records the coordinator's session usage from its own session log, and nothing while off [C7,#9685]. @pullboard-test-input source-cell apps/cli packages/stats packages/store */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { checkpointAfterMove } from '../../../../packages/stats/index.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** The model name the fixture session log reports. */
const LOG_MODEL = ['fixture', 'coordinator'].join('-');
const SESSION = 'coordinator-session-1';
const NOW = Date.parse('2026-01-02T00:00:00.000Z');

/** The real fixture board with its coordinator seat, a session log with one assistant message, and the context a checkpoint reads. */
async function setup(t) {
  const { board } = await fixture(t);
  const files = privateFixtureFiles('pullboard-coordinator-usage-');
  files.write(`${SESSION}.jsonl`, `${JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z',
    message: { id: 'm1', model: LOG_MODEL, usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } })}\n`);
  files.write('git/keep', '');
  const ctx = { info: { commonDir: join(files.root, 'git') }, clock: { now: () => new Date(NOW) }, io: { err: () => {} } };
  const environment = { CLAUDE_CODE_SESSION_ID: SESSION, PULLBOARD_SESSION_LOG: join(files.root, `${SESSION}.jsonl`) };
  const ordered = (_ctx, target, operation, args) => store[operation](target, ...args);
  return { board, ctx, environment, ordered };
}

/** The coordinator usage rows the board holds. */
function rows(board) {
  return board.db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key LIKE 'coordinator:%'").all()
    .map(row => ({ key: row.meta_key, ...JSON.parse(row.meta_value) }));
}

test('cli.journeys-stats-coordinator-record.with-stats-recordcoordinatorusage-on-a-coordinator: clause 1: with stats.recordCoordinatorUsage on, a coordinator session log yields one coordinator:<session id> row with its tokens and model [C7,#9685]', async t => {
  const { board, ctx, environment, ordered } = await setup(t);
  await checkpointAfterMove(ctx, board, { agent: 'coordinator', item: 1, operation: 'merged' }, { ordered, environment, recordCoordinatorUsage: true });
  const [row, ...others] = rows(board);
  assert.equal(others.length, 0, 'one row');
  assert.equal(row.key, `coordinator:${SESSION}`);
  const [record] = row.records;
  assert.deepEqual([record.model, record.inputTokens, record.outputTokens, record.freshInputTokens, record.cacheReadInputTokens, record.cacheWriteInputTokens],
    [LOG_MODEL, 10, 4, 3, 5, 2]);
  await checkpointAfterMove(ctx, board, { agent: 'coordinator', item: 1, operation: 'merged' }, { ordered, environment, recordCoordinatorUsage: true });
  assert.equal(rows(board).length, 1, 'a second move over an unchanged log records nothing more');
});

test('cli.journeys-stats-coordinator-record.with-stats-recordcoordinatorusage-off-nothing-is: clause 2: with stats.recordCoordinatorUsage off, nothing is recorded [C7,#9685]', async t => {
  const { board, ctx, environment, ordered } = await setup(t);
  await checkpointAfterMove(ctx, board, { agent: 'coordinator', item: 1, operation: 'merged' }, { ordered, environment, recordCoordinatorUsage: false });
  await checkpointAfterMove(ctx, board, { agent: 'coordinator', item: 1, operation: 'merged' }, { ordered, environment });
  assert.equal(rows(board).length, 0);
});
