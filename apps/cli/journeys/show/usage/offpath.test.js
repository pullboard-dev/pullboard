/** A board command only marks its usage checkpoint due; a detached worker reads just the new log bytes [N2]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { openSync } from 'node:fs';
import { closeSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { addItem } from '../../../../../packages/store/index.js';
import { closeBoard } from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { sessionSnapshot } from '../../../../../packages/stats/index.js';
import { nativeUsage } from '../../../../../packages/stats/index.js';
import { usageDueDirectory } from '../../../../../packages/stats/index.js';
import { usageCheckpointWorkerEntrypoint } from '../../../index.js';
import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

const SESSION = 'offpath-fixture-claude';
const LOG_BYTES = 50 * 1024 * 1024;
/** Fixed fixture clock: history predates every real claim, and the cursor test needs no wall clock. */
const HISTORY_AT = new Date('2026-01-01T00:00:00.000Z');
const CUTOFF = Date.parse('2026-01-01T00:00:30.000Z');
const LATER = new Date('2026-01-01T00:01:00.000Z');

/** One native-shaped Claude usage row; fixture data, not provider execution. */
function row(id, input, output, at = new Date()) {
  return JSON.stringify({ timestamp: at.toISOString(), type: 'assistant', message: { id, model: 'fixture-claude', usage: { input_tokens: input, output_tokens: output } } }) + '\n';
}

/** Write about `bytes` of history that all predates the claim. */
function bigLog(file, bytes) {
  const at = HISTORY_AT;
  const pad = 'x'.repeat(400);
  const chunk = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = JSON.stringify({ timestamp: at.toISOString(), type: 'assistant', message: { id: `history-${i}`, model: 'fixture-claude', usage: { input_tokens: 1, output_tokens: 1 }, content: pad } }) + '\n';
    chunk.push(line);
    size += Buffer.byteLength(line);
  }
  writeFileSync(file, chunk.join(''));
}

/** A joined fixture seat with one claimable item and a native session log of `bytes` (50 MB by default; 0 writes no log). */
function fixture(bytes = LOG_BYTES) {
  const box = helpers.project('true');
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file journey: the real CLI seat shares this repository board file.
  const board = openBoard(boardFile);
  let id;
  try {
    id = addItem(board, { by: 'coordinator', lane: 'web', title: 'Off-path usage fixture', specIds: ['G1'],
      criterion: 'usage is attributed off the command path', check: 'test -f web/ready',
      checkBaseline: { command: 'test -f web/ready', result: 'red', main: box.git(box.repo, 'rev-parse', 'HEAD'), seconds: 0 } });
  } finally { closeBoard(board); }
  const directory = join(box.dir, 'claude', 'projects', 'private-fixture');
  mkdirSync(directory, { recursive: true });
  const log = join(directory, `${SESSION}.jsonl`);
  if (bytes) bigLog(log, bytes);
  return { box, id, log, common: join(box.repo, '.git') };
}

/** Run the real CLI as the fixture's Claude session, in-line or with the default detached checkpoint. */
function seat(box, args, mode) {
  const env = { ...box.env, CLAUDE_CONFIG_DIR: join(box.dir, 'claude'), CLAUDE_CODE_SESSION_ID: SESSION };
  if (mode === 'inline') env.PULLBOARD_USAGE_CHECKPOINT = 'inline';
  else delete env.PULLBOARD_USAGE_CHECKPOINT;
  const started = performance.now();
  const result = runFixtureChild(process.execPath, [helpers.BIN, ...args], { cwd: box.web, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
  return performance.now() - started;
}

/** Claim, spend 100/10 tokens over a streamed message, release: the same journey for both modes. */
function journey(box, id, log, mode) {
  const claimMs = seat(box, ['claim', String(id)], mode);
  const message = row('offpath-spend', 100, 10);
  appendFileSync(log, message);
  appendFileSync(log, message); // Stream repetition must not double charge.
  appendFileSync(log, row('offpath-more', 5, 1));
  seat(box, ['release', String(id), '--reason', 'OTHER', '--note', 'Close the off-path usage fixture claim.', '--no-next'], mode);
  return claimMs;
}

/** Hold the worker lock as a live process so queued checkpoints wait for this test to run them. */
function holdWorker(common) {
  const due = usageDueDirectory(common);
  mkdirSync(due, { recursive: true });
  writeFileSync(join(due, 'worker.lock'), String(process.pid));
  return due;
}

/**
 * Milliseconds the claim's own post-move usage step takes for this seat, in a real CLI context: the fastest of three.
 * Why: the bar bounds only the usage share of a claim; the rest of a claim's time belongs to other items.
 */
function checkpointMs(box, id) {
  const env = { ...box.env, CLAUDE_CONFIG_DIR: join(box.dir, 'claude'), CLAUDE_CODE_SESSION_ID: SESSION };
  delete env.PULLBOARD_USAGE_CHECKPOINT;
  const module = (path) => JSON.stringify(new URL(path, import.meta.url).href);
  const code = `import {cliContext$context as context,cliContext$withBoard as withBoard} from ${module('../../../index.js')};
    import {whoAmI} from ${module('../../../index.js')};
    import {ordered} from ${module('../../../index.js')};
    import {checkpointAfterMove} from ${module('../../../../../packages/stats/index.js')};
    import {usageCheckpointWorkerEntrypoint} from ${module('../../../index.js')};
    const nativeBoard=await import(${module('../../../../lib/src/logic/native.js')});
    const ctx=context({cwd:process.cwd(),nativeBoard,say(){},err(message){process.stderr.write(message+'\\n');}});
    const times=[];
    for (let run=0;run<3;run++) await withBoard(ctx,async board=>{
      const request={agent:whoAmI(ctx,board).id,item:${id},operation:'claim'};
      const started=performance.now();
      await checkpointAfterMove(ctx,board,request,{ordered,worker:usageCheckpointWorkerEntrypoint()});
      times.push(performance.now()-started);
    });
    process.stdout.write(String(Math.min(...times)));`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', code], { cwd: box.web, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return Number(result.stdout);
}

/** Public numeric usage for one item, without its elapsed time. */
async function usage(box, id) {
  const shown = JSON.parse((await box.runLocal(box.repo, 'show', String(id), '--json')).out).usage;
  return { inputTokens: shown.inputTokens, outputTokens: shown.outputTokens, freshInputTokens: shown.freshInputTokens,
    cacheReadInputTokens: shown.cacheReadInputTokens, cacheWriteInputTokens: shown.cacheWriteInputTokens, models: shown.models, unknownReasons: shown.unknownReasons };
}

test('clause 1: 50 MB of session logs add under 50 ms of usage work to a claim and the detached checkpoint matches the in-line totals [N2]', async () => {
  const inline = fixture();
  journey(inline.box, inline.id, inline.log, 'inline');
  const expected = await usage(inline.box, inline.id);
  assert.equal(expected.inputTokens, 105, 'the in-line checkpoint attributes only post-claim spend, once per streamed message');
  assert.equal(expected.outputTokens, 11);

  const deferred = fixture();
  const due = holdWorker(deferred.common);
  journey(deferred.box, deferred.id, deferred.log, 'background');
  const requests = readdirSync(due).filter((name) => name.endsWith('.json'));
  assert.equal(requests.length, 2, 'claim and release each recorded one due checkpoint');
  assert.equal(existsSync(join(deferred.common, 'pullboard', 'cost-ledger.json')), false, 'no command did usage work');
  assert.equal(JSON.parse((await deferred.box.runLocal(deferred.box.repo, 'show', String(deferred.id), '--json')).out).usage, undefined, 'nothing is attributed until the worker runs');

  rmSync(join(due, 'worker.lock'));
  const env = { ...deferred.box.env };
  for (const marker of AGENT_SHELL_MARKERS) delete env[marker];
  delete env.PULLBOARD_USAGE_CHECKPOINT;
  const worker = runFixtureChild(process.execPath, [usageCheckpointWorkerEntrypoint(), deferred.common], { cwd: deferred.common, env, encoding: 'utf8' });
  assert.equal(worker.status, 0, worker.stdout + worker.stderr);
  assert.deepEqual(readdirSync(due).filter((name) => name.endsWith('.json')), [], 'the worker drained every due checkpoint');
  assert.deepEqual(await usage(deferred.box, deferred.id), expected, 'the detached checkpoint records the in-line totals');

  // The usage step a claim runs after its move, for the 50 MB seat against a seat with no logs; a live worker holds the queue.
  const empty = fixture(0);
  holdWorker(empty.common);
  holdWorker(deferred.common);
  const withoutLogsMs = checkpointMs(empty.box, empty.id);
  const withLogsMs = checkpointMs(deferred.box, deferred.id);
  const addedMs = withLogsMs - withoutLogsMs;
  assert.ok(addedMs < 50, `50 MB of session logs added ${addedMs.toFixed(1)} ms to the claim's usage step`); // budget: the bar's 50 ms ceiling over a measured baseline seat with no logs
  assert.equal(existsSync(join(empty.common, 'pullboard', 'cost-ledger.json')), false, 'the usage step only marks a checkpoint due');
});

test('a checkpoint reads only the log bytes added since its last offset [N2]', async () => {
  const box = helpers.sandbox();
  const file = join(box.dir, 'native-session.jsonl');
  const source = { provider: 'claude', file };
  writeFileSync(file, row('first', 8, 2, HISTORY_AT) + row('second', 4, 1, HISTORY_AT));
  const cursors = {};
  const first = sessionSnapshot(source, undefined, CUTOFF, cursors);
  assert.deepEqual([first.totals['fixture-claude'].inputTokens, first.totals['fixture-claude'].outputTokens], [12, 3]);
  assert.equal(cursors[file].offset, statSync(file).size, 'the cursor rests at the end of the consumed lines');
  // Overwrite the old bytes in place with same-length junk: a reader that rereads them would lose the totals.
  const old = statSync(file).size;
  const fd = openSync(file, 'r+');
  try { writeSync(fd, Buffer.alloc(old, 0x20), 0, old, 0); } finally { closeSync(fd); }
  appendFileSync(file, row('third', 100, 10, HISTORY_AT));
  const second = sessionSnapshot(source, first, CUTOFF, cursors);
  assert.deepEqual([second.totals['fixture-claude'].inputTokens, second.totals['fixture-claude'].outputTokens], [112, 13], 'only the appended row was read');
  assert.equal(cursors[file].offset, statSync(file).size);
  // A row after the cutoff waits for a later checkpoint instead of being skipped.
  appendFileSync(file, row('fourth', 1, 1, LATER));
  assert.equal(sessionSnapshot(source, second, CUTOFF, cursors).totals['fixture-claude'].inputTokens, 112);
  assert.equal(sessionSnapshot(source, second, LATER.getTime(), cursors).totals['fixture-claude'].inputTokens, 113);
  writeFileSync(file, '{}\n');
  assert.equal(sessionSnapshot(source, second, CUTOFF, cursors), null, 'a truncated source stays unknown');
});

/** Native Claude message ids stay deduplicated across the complete session, as the old batch reader does. */
test('a streamed update beyond the cursor window preserves old whole-log totals [N2]', async () => {
  const box = helpers.sandbox();
  const file = join(box.dir, 'dedup-session.jsonl');
  const source = { provider: 'claude', file };
  writeFileSync(file, Array.from({ length: 257 }, (_, i) => row('history-' + i, 1, 1, HISTORY_AT)).join(''));
  const cursors = {};
  const first = sessionSnapshot(source, undefined, CUTOFF, cursors);
  assert.equal(first.totals['fixture-claude'].inputTokens, 257);
  appendFileSync(file, row('history-0', 5, 7, HISTORY_AT));
  const batch = nativeUsage(source, undefined, CUTOFF);
  assert.deepEqual([batch.reduce((n, e) => n + e.inputTokens, 0), batch.reduce((n, e) => n + e.outputTokens, 0)], [261, 263], 'the retained whole-log reader is the old oracle');
  const updated = sessionSnapshot(source, first, CUTOFF, cursors);
  assert.deepEqual([updated.totals['fixture-claude'].inputTokens, updated.totals['fixture-claude'].outputTokens], [261, 263],
    'the same native message id replaces its original usage, even after 256 other messages');
});
