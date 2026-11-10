/**
 * The pullboard ledger command, in its own module so an item adding another command never edits these lines.
 * Bare, it lists built items [R1]; with --since or --item it prints the pipeline ledger: where every millisecond,
 * runner second and agent token of the loop went, per hop [C7].
 */
import { verifiedPasskeyRowDecision } from '../../../../../packages/person/index.js';
import * as store from '../../../../../packages/store/index.js';
import { ledgerLines } from '../../../../../packages/stats/index.js';
import { readPipelineLedger } from '../../../../../packages/stats/index.js';
import { loadKeyedResult } from '../../../../../packages/pin/index.js';
import { saveKeyedResult } from '../../../../../packages/pin/index.js';
import { join } from 'node:path';
import {
  agentApprovalLine,
  itemAgentApprovals,
  specApprovalState,
} from '../../../../../packages/spec/index.js';
import {
  agentDisplayName,
  context,
  refusal,
  withBoard,
  withBoardRead,
} from '../entry.js';
import { sinceCutoff } from '../trace.js';

const PIPELINE_USAGE = 'pullboard ledger [--since 2h] [--item <id>] [--json] reports where the pipeline\'s time, compute and tokens went';

/** Run `pullboard ledger` and return its exit code. */
export function run(io, { first, second, rest = [], values = {} } = {}) {
  if (values.since !== undefined || values.item !== undefined) return pipeline(io, { first, second, rest, values });
  const ctx = context(io);
  const { items, stats, agents, approval } = withBoard(ctx, (board) => ({
    items: store.listItems(board, { all: true }).map((item) => ({
      ...item,
      check: store.verdictsFor(board, item.item_id).at(-1)?.check ?? 'unknown',
    })),
    stats: store.stats(board),
    agents: store.listAgents(board),
    approval: specApprovalState(ctx.info.root, { board, config: ctx.config }, { store, verifiedPasskeyRowDecision }),
  }));
  const built = items.filter((item) => item.item_built_by && item.item_status !== 'withdrawn').reverse()
    .map(item => ({ ...item, agentApproved: itemAgentApprovals(item, approval), approvalQualification: agentApprovalLine(itemAgentApprovals(item, approval)) }));
  io.result?.({ items: built, stats });
  const cell = (text) => String(text ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ');
  io.say(`${stats.items.verified} verified by a second agent · ${stats.items.submitted} awaiting verification · ${stats.rejected} rejection${stats.rejected === 1 ? '' : 's'} along the way`);
  io.say('');
  io.say('| # | Lane | Item | Spec | Built by | Verified by | Check | Commit | Merged |');
  io.say('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const item of built) {
    io.say(`| ${item.item_id} | ${item.item_lane} | ${cell(item.item_title)} | ${cell(item.item_spec_ids)} | ${agentDisplayName(agents, ctx.config, item.item_built_by)} | ${agentDisplayName(agents, ctx.config, item.item_verified_by)} | ${item.check === 'none' ? 'unchecked' : item.check} | ${(item.item_commit ?? '').slice(0, 12)} | ${(item.item_merged_commit ?? '').slice(0, 12)} |`);
    if (item.item_status === 'verified' && item.approvalQualification) io.say(`  #${item.item_id}: ${item.approvalQualification}`);
  }
  return 0;
}

/**
 * Print the pipeline ledger for a window or one item, reading the board, span files and session logs without writing
 * any of them.
 */
function pipeline(io, { first, second, rest, values }) {
  if (first || second || rest.length || Object.keys(values).some(key => !['json', 'since', 'item'].includes(key))) throw refusal('USAGE', PIPELINE_USAGE);
  const window = typeof values.since === 'string' ? values.since : '2h';
  const ctx = context(io);
  const now = ctx.clock.now().getTime();
  const since = sinceCutoff(window, now);
  if (since === null) throw refusal('USAGE', `--since takes a number and s, m, h or d, like 2h; ${PIPELINE_USAGE}`);
  const item = values.item === undefined ? null : Number(String(values.item).replace(/^#/u, ''));
  if (item !== null && !Number.isSafeInteger(item)) throw refusal('USAGE', `--item takes an item number, like --item 42; ${PIPELINE_USAGE}`);
  // Parsed session logs persist as pin keyed results, so a later ledger reads only what the logs gained.
  const folder = join(ctx.info.commonDir, 'pullboard', 'ledger-cache');
  const cache = { load: key => loadKeyedResult(folder, key), save: (key, bytes) => saveKeyedResult(folder, key, bytes) };
  const ledger = withBoardRead(ctx, board => readPipelineLedger(board.db, { commonDir: ctx.info.commonDir, since, now, item, cache }));
  io.result?.(ledger);
  if (item !== null && !ledger.ledgers.length) { io.say(`#${item} has no claim on the board yet; nothing to trace`); return 0; }
  for (const line of ledgerLines(ledger, window)) io.say(line);
  return 0;
}
