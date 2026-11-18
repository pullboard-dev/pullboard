/** @pullboard-module-loads apps/cli/src/io/test/status-outcomes.js */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refused } from '../../../../../packages/kernel/light.js';
import { queuesTestRun } from '../../../../../packages/drive/index.js';
import { testRunItem } from '../../../../../packages/drive/index.js';
import { queueTestRun } from '../../../../../packages/drive/index.js';
import { cancelTestRun } from '../../../../../packages/drive/index.js';
import { readTestRun } from '../../../../../packages/drive/index.js';
import { testRunLines } from '../../../../../packages/drive/index.js';
import { workTestRun } from '../../../../../packages/drive/index.js';
import { headCommit } from '../../../../../packages/git/index.js';
import { boardRunsHolder } from '../../../../../packages/store/index.js';
import { testStatusOutcomesEnabled } from '../../../../../packages/config/index.js';
import { context } from '../context.js';
import { withBoard } from '../context.js';
import { withBoardRead } from '../context.js';

/** Loads the status-outcomes reader at the first status read that wants it, so no other command pays for it [C7,#10212]. */
const requireModule = createRequire(import.meta.url);

/** The CLI entry a queued run's worker runs: this build, named here so packages/drive never reaches into apps/. */
const CLI_ENTRY = fileURLToPath(new URL('../../../pullboard.js', import.meta.url));

/**
 * The seat's live build claims: `item` is its sole claim, since ambiguous or absent ownership grants no item priority,
 * and `held` says it holds any, which makes its runs queue [P7].
 */
async function seatClaims(ctx, agent) {
  const { itemsInStatus } = await import('../../../../../packages/store/index.js');
  const { itemFolderIdentity } = await import('../../../../../packages/items/index.js');
  return withBoardRead(ctx, board => {
    const claims = itemsInStatus(board, 'claimed', agent);
    const folder = itemFolderIdentity(board, ctx.info.root)?.item ?? null;
    const ids = claims.map(claim => claim.item_id);
    return { item: testRunItem({ folder, claims: ids }), held: claims.length > 0, claims: ids };
  });
}

/**
 * Run `pullboard test <files>` and return its exit code. An agent seat's call queues the run on the board and returns
 * at once with its run id; `pullboard next` hands the result back. A seat holding a claim always queues, even with
 * `--wait`. For a person or a script with no claim, `--wait` runs it here and blocks: 0 when every named file passes.
 * `--status <id>` prints one run's state once; `--cancel <id>` stops the seat's own queued or running run.
 * `--census [--out <jsonl>]` runs every tracked test file as a few shards per runner and writes a row per file.
 *
 * Why queue for seats: seats sat 16-54 min in sleep-and-pgrep loops on runner-queued runs; waiting is an error [C7].
 */
export async function run(io, { first, second, rest, values }) {
  const ctx = context(io);
  if (values.status !== undefined) return sayTestRunStatus(io, ctx, values.status);
  if (values.cancel !== undefined) return cancelRun(io, ctx, values.cancel);
  if (values.census === true) {
    return (await import('../test/census.js')).runCensus(io, ctx, values, { prefixes: [first, second, ...rest].filter(prefix => prefix !== undefined && prefix !== '') });
  }
  const { expandTestFolders } = await import('../../../../../packages/runners/index.js');
  const files = expandTestFolders(ctx.info.root, [first, second, ...rest].filter((file) => file !== undefined && file !== ''));
  if (values.diagnose === true && (files.length !== 1 || values.affected === true)) throw new Refused('USAGE', '--diagnose requires exactly one named test file');
  const seat = (await import('../board/access.js')).resourceAgent(ctx);
  const agent = seat ?? `pid-${process.pid}`;
  const owned = seat === undefined ? { item: undefined, held: false, claims: [] } : await seatClaims(ctx, agent);
  const { held } = owned;
  // --item N proves that one claim; with none named, a green run proves every claim the seat holds [C7].
  const named = values.item === undefined ? undefined : Number(values.item);
  if (named !== undefined && !owned.claims.includes(named)) throw new Refused('NOT_YOURS', `--item ${values.item} is not a claim this seat holds; run pullboard whoami to see its claims`);
  const item = testRunItem({ named, folder: owned.item, claims: owned.claims });
  const items = named === undefined ? owned.claims : [named];
  if (values.diagnose !== true && queuesTestRun(ctx, seat, values, process.env, { claimed: held })) return queueSeatRun(io, ctx, { agent, item, items, files, values }, await import('../test/pull.js'));
  if (values['test-run'] !== undefined) {
    const { heartbeatSeat } = await import('../../../../../packages/store/index.js');
    await workTestRun(work => withBoard(ctx, work), values['test-run'], async () => (await (await import('../test/here.js')).runHere(io, ctx, { agent, item, items, files, values })).payload,
      { beatSeat: board => heartbeatSeat(board, agent), runs: withBoardRead(ctx, board => boardRunsHolder(board, ctx.file)) });
    return 0;
  }
  return (await (await import('../test/here.js')).runHere(io, ctx, { agent, item, items, files, values })).code;
}

/**
 * Queue a seat's run as a board-held job and print its one line. Refuses at once what the worker would refuse
 * later (no files, a missing file, no test runner), so a seat never learns of a typo through next.
 */
async function queueSeatRun(io, ctx, { agent, item, items, files, values }, pulledRun = null) {
  const affected = values.affected === true;
  if (affected && files.length) throw new Refused('USAGE', 'use pullboard test --affected without file arguments, or name the files without --affected');
  if (!affected && !files.length) throw new Refused('USAGE', 'name the test files to run: pullboard test <file> [more files]');
  const missing = files.filter(file => !existsSync(join(ctx.info.root, file)));
  if (missing.length) throw new Refused('NO_TEST_FILE', `no such test file in this checkout: ${missing.join(', ')}`);
  if (!affected && (typeof ctx.config.affectedTests !== 'string' || !ctx.config.affectedTests.trim())) {
    throw new Refused('NO_TEST_RUNNER', 'set "affectedTests" in pullboard.json to the command that runs named test files, like "node apps/cli/src/io/run/tests.js"');
  }
  // A pulled run fetches only the committed source, so its refusal of an uncommitted change comes now, not through next [P7].
  if (pulledRun?.pullTestWanted(item, values)) await pulledRun.refuseUncommitted(ctx.info.root);
  // runs_store on: the run's job rows go to the runs file; off (the default) the holder is null and the board holds them as before [P7,#9111].
  const runs = withBoardRead(ctx, board => boardRunsHolder(board, ctx.file));
  const queued = queueTestRun(ctx, work => withBoard(ctx, work), { agent, item, items, named: values.item !== undefined, head: headCommit(ctx.info.root), files, affected, compareMain: values['compare-main'] === true, noFileLimit: values['no-file-limit'] === true },
    { bin: CLI_ENTRY, runs });
  io.result?.({ queued: true, run: queued.id, status: queued.status, files: queued.files, log: queued.log });
  if (values.wait === true || process.env.PULLBOARD_TEST_WAIT === '1') io.say('a seat holding a claim never blocks on its own test run; it queues');
  io.say(`queued test run ${queued.id}; the board runs it and pullboard next brings the result; read it any time with pullboard test --status ${queued.id}; take your next item now: pullboard next --take`);
  return 0;
}

/** Print one queued run's state once, without waiting: `pullboard test --status <id>`. */
function sayTestRunStatus(io, ctx, id) {
  if (typeof id !== 'string' || !id.trim()) throw new Refused('USAGE', 'pass the run id: pullboard test --status <run id>');
  const found = withBoardRead(ctx, board => readTestRun(board, id.trim(), { runs: boardRunsHolder(board, ctx.file) }));
  // With test.statusOutcomes on, a finished run's document also carries each case's outcome, read from the frames the log's tail keeps [#9085].
  io.result?.(testStatusOutcomesEnabled() && found.log && !['queued', 'running'].includes(found.status) ? { ...found, outcomes: requireModule('../test/status-outcomes.js').statusOutcomes(found.log) } : found);
  if (found.status === 'queued' || found.status === 'running') io.say(`test run ${found.id} ${found.status}: ${found.files.join(' ') || '--affected'}; pullboard next brings the result`);
  else for (const line of testRunLines(found)) io.say(line);
  return ['red', 'lost', 'refused'].includes(found.status) ? 1 : 0;
}

/** Cancel this seat's own queued or running run and free its slot: `pullboard test --cancel <run id>`. */
async function cancelRun(io, ctx, id) {
  if (typeof id !== 'string' || !id.trim()) throw new Refused('USAGE', 'pass the run id: pullboard test --cancel <run id>');
  const seat = (await import('../board/access.js')).resourceAgent(ctx);
  if (seat === undefined) throw new Refused('NOT_YOURS', 'only the seat that queued a run cancels it; run pullboard test --cancel from that seat\'s folder');
  const cancelled = withBoard(ctx, board => cancelTestRun(board, id.trim(), seat, { runs: boardRunsHolder(board, ctx.file) }));
  io.result?.(cancelled);
  io.say(`cancelled test run ${cancelled.id}: its slot is free; queue it again with pullboard test ${cancelled.files.join(' ') || '--affected'}`);
  return 0;
}
