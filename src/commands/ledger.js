/** The pullboard ledger command, in its own module so an item adding another command never edits these lines. */
import { verifiedPasskeyRowDecision } from '../person-row-proof.js';
import * as store from '../board.js';
import {
  agentApprovalLine,
  itemAgentApprovals,
  specApprovalState,
} from '../spec-approval.js';
import {
  agentDisplayName,
  context,
  withBoard,
} from '../cli.js';

/** Run `pullboard ledger` and return its exit code. */
export function run(io) {
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
