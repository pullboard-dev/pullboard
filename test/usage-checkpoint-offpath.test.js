/** @pullboard-test-input source-tree */
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
import { addItem } from '../packages/store/index.js';
import { closeBoard } from '../packages/store/index.js';
import { openBoard } from '../apps/lib/index.js';
import { sessionSnapshot } from '../packages/stats/index.js';
import { usageDueDirectory } from '../packages/stats/index.js';
import { usageCheckpointWorkerEntrypoint } from '../apps/lib/index.js';
import { AGENT_SHELL_MARKERS } from '../packages/kernel/index.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

const SESSION = 'offpath-fixture-claude';
const LOG_BYTES = 50 * 1024 * 1024;

/** One native-shaped Claude usage row; fixture data, not provider execution. */
function row(id, input, output, at = new Date()) {
  return JSON.stringify({ timestamp: at.toISOString(), type: 'assistant', message: { id, model: 'fixture-claude', usage: { input_tokens: input, output_tokens: output } } }) + '\n';
}

/** Write about 50 MB of history that all predates the claim. */
function bigLog(file) {
  const at = new Date(Date.now() - 60_000);
  const pad = 'x'.repeat(400);
  const chunk = [];
  let size = 0;
  for (let i = 0; size < LOG_BYTES; i++) {
    const line = JSON.stringify({ timestamp: at.toISOString(), type: 'assistant', message: { id: `history-${i}`, model: 'fixture-claude', usage: { input_tokens: 1, output_tokens: 1 }, content: pad } }) + '\n';
    chunk.push(line);
    size += Buffer.byteLength(line);
  }
  writeFileSync(file, chunk.join(''));
}

/** A joined fixture seat with one claimable item and a 50 MB native session log. */
function fixture() {
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
  bigLog(log);
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

/** Public numeric usage for one item, without its elapsed time. */
function usage(box, id) {
  const shown = JSON.parse(box.run(box.repo, 'show', String(id), '--json').out).usage;
  return { inputTokens: shown.inputTokens, outputTokens: shown.outputTokens, freshInputTokens: shown.freshInputTokens,
    cacheReadInputTokens: shown.cacheReadInputTokens, cacheWriteInputTokens: shown.cacheWriteInputTokens, models: shown.models, unknownReasons: shown.unknownReasons };
}

test('a claim with 50 MB of session logs returns in under 1 s and the detached checkpoint matches the in-line totals [N2]', () => {
  const inline = fixture();
  journey(inline.box, inline.id, inline.log, 'inline');
  const expected = usage(inline.box, inline.id);
  assert.equal(expected.inputTokens, 105, 'the in-line checkpoint attributes only post-claim spend, once per streamed message');
  assert.equal(expected.outputTokens, 11);

  const deferred = fixture();
  const due = usageDueDirectory(deferred.common);
  mkdirSync(due, { recursive: true });
  // Hold the worker lock as a live process so the queued work waits for this test to run it.
  writeFileSync(join(due, 'worker.lock'), String(process.pid));
  const claimMs = journey(deferred.box, deferred.id, deferred.log, 'background');
  assert.ok(claimMs < 1000, `the claim waited ${Math.round(claimMs)} ms`);
  const requests = readdirSync(due).filter((name) => name.endsWith('.json'));
  assert.equal(requests.length, 2, 'claim and release each recorded one due checkpoint');
  assert.equal(existsSync(join(deferred.common, 'pullboard', 'cost-ledger.json')), false, 'no command did usage work');
  assert.equal(usage(deferred.box, deferred.id).inputTokens, null, 'nothing is attributed until the worker runs');

  rmSync(join(due, 'worker.lock'));
  const env = { ...deferred.box.env };
  for (const marker of AGENT_SHELL_MARKERS) delete env[marker];
  delete env.PULLBOARD_USAGE_CHECKPOINT;
  const worker = runFixtureChild(process.execPath, [usageCheckpointWorkerEntrypoint(), deferred.common], { cwd: deferred.common, env, encoding: 'utf8' });
  assert.equal(worker.status, 0, worker.stdout + worker.stderr);
  assert.deepEqual(readdirSync(due).filter((name) => name.endsWith('.json')), [], 'the worker drained every due checkpoint');
  assert.deepEqual(usage(deferred.box, deferred.id), expected, 'the detached checkpoint records the in-line totals');
});

test('a checkpoint reads only the log bytes added since its last offset [N2]', () => {
  const box = helpers.sandbox();
  const file = join(box.dir, 'native-session.jsonl');
  const source = { provider: 'claude', file };
  writeFileSync(file, row('first', 8, 2) + row('second', 4, 1));
  const cursors = {};
  const first = sessionSnapshot(source, undefined, Date.now(), cursors);
  assert.deepEqual([first.totals['fixture-claude'].inputTokens, first.totals['fixture-claude'].outputTokens], [12, 3]);
  assert.equal(cursors[file].offset, statSync(file).size, 'the cursor rests at the end of the consumed lines');
  // Overwrite the old bytes in place with same-length junk: a reader that rereads them would lose the totals.
  const old = statSync(file).size;
  const fd = openSync(file, 'r+');
  try { writeSync(fd, Buffer.alloc(old, 0x20), 0, old, 0); } finally { closeSync(fd); }
  appendFileSync(file, row('third', 100, 10));
  const second = sessionSnapshot(source, first, Date.now(), cursors);
  assert.deepEqual([second.totals['fixture-claude'].inputTokens, second.totals['fixture-claude'].outputTokens], [112, 13], 'only the appended row was read');
  assert.equal(cursors[file].offset, statSync(file).size);
  // A row after the cutoff waits for a later checkpoint instead of being skipped.
  const later = new Date(Date.now() + 60_000);
  appendFileSync(file, row('fourth', 1, 1, later));
  assert.equal(sessionSnapshot(source, second, Date.now(), cursors).totals['fixture-claude'].inputTokens, 112);
  assert.equal(sessionSnapshot(source, second, later.getTime(), cursors).totals['fixture-claude'].inputTokens, 113);
  writeFileSync(file, '{}\n');
  assert.equal(sessionSnapshot(source, second, Date.now(), cursors), null, 'a truncated source stays unknown');
});
