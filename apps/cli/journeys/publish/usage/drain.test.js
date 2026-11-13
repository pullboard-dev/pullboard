/** @pullboard-test-input apps/lib/index.js */
/** A usage drain writes in short batches and lets other writers in between them [C7,N2]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openKitBoard } from '../../../tests/fixtures/testkit.js';
import { seedPendingUsage } from '../../../tests/fixtures/testkit.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { captureCommandInProcess } from '../../../tests/fixtures/process.js';
import { context } from '../../../index.js';
import { withBoard } from '../../../index.js';
import { whoAmI } from '../../../index.js';
import { cli$ordered as ordered } from '../../../index.js';
import * as nativeBoard from '../../../../lib/index.js';
import { publishUsage } from '../../../../../packages/stats/index.js';
import { storedSeatUsage } from '../../../../../packages/stats/index.js';

const COUNT = 150;

/** A private joined repository with COUNT closed claims whose usage is pending; fixture data, not provider usage. */
async function fixture(t) {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const who = await box.inProcess(box.web, 'whoami', '--json');
  assert.equal(who.code, 0, who.err);
  const agent = JSON.parse(who.out).id;
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const board = openKitBoard(file, undefined, { gitRoot: box.web });
  const ids = seedPendingUsage(store, board, { agent, lane: 'web', main: box.git(box.repo, 'rev-parse', 'HEAD'), count: COUNT });
  return { box, helpers, board, agent, ids, file };
}

test('the usage drain publishes in bounded batches, each its own short write, and another write is admitted between them [C7,N2]', async t => {
  const { box, helpers, board, agent, ids, file } = await fixture(t);
  t.after(() => store.closeBoard(board));
  const env = { ...box.env, CODEX_HOME: join(box.dir, 'codex'), CLAUDE_CONFIG_DIR: join(box.dir, 'claude') };
  for (const key of ['CODEX_THREAD_ID','CODEX_SESSION_ID','CLAUDE_CODE_SESSION_ID','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','AI_AGENT','CODEX_CI','CODEX_SHELL']) delete env[key];
  // The drain runs inside the production capture harness, which restores the process environment afterwards.
  let report = null;
  const result = await captureCommandInProcess(async (_argv, io) => {
    const other = openKitBoard(file, undefined, { gitRoot: box.web }), admitted = [], holds = [], batches = [];
    // Between two batches a second connection writes, as another seat's command would while the drain runs.
    const between = async (c, b, op, args, rest) => {
      const r = await ordered(c, b, op, args, rest);
      batches.push(args[0].items.length + args[0].sharedSessions.length);
      try { store.atomic(other, () => store.logEvent(other, 'coordinator', 'fact', ids[0], { id: crypto.randomUUID(), kind: 'note', text: 'admitted ' + batches.length, ref: null, supersedes: null })); admitted.push(batches.length); }
      catch (e) { admitted.push(e.code ?? String(e)); }
      return r;
    };
    const ctx = context({ cwd: io.cwd, nativeBoard, say() {}, err() {} });
    await withBoard(ctx, async drainBoard => {
      const exec = drainBoard.db.exec.bind(drainBoard.db); let at = null;
      drainBoard.db.exec = sql => { const r = exec(sql); if (sql === 'BEGIN IMMEDIATE') at = performance.now(); if (sql === 'COMMIT' && at !== null) { holds.push(performance.now() - at); at = null; } return r; };
      await publishUsage(ctx, drainBoard, { agent: whoAmI(ctx, drainBoard).id, operation: 'refresh' }, { ordered: between, drain: true });
    });
    store.closeBoard(other);
    report = { admitted, holds, batches };
    return 0;
  }, [], { cwd: box.web, env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { admitted, holds, batches } = report;
  t.diagnostic(`batches ${JSON.stringify(batches)}; lock holds ms ${JSON.stringify(holds)}`);
  assert.ok(batches.length >= 2, `the drain wrote ${batches.length} batch(es); it must split its work`);
  assert.equal(batches.reduce((sum, n) => sum + n, 0), COUNT);
  assert.ok(batches[0] < COUNT, 'the first write carries a bounded share, not every pending revision');
  assert.deepEqual(admitted, batches.map((_, i) => i + 1), 'a second writer was admitted after every batch while pending revisions remained');
  assert.ok(Math.max(...holds) < 1000, `a batch held the board write lock ${JSON.stringify(holds)} ms`);
  const count = () => board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind='usage'").get().n;
  assert.equal(count(), COUNT);
  assert.deepEqual(storedSeatUsage(board, agent).map(row => row.item).sort((a, b) => a - b), ids);
});
