/** The pullboard rigor command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board.js';
import { parseProcessCensus } from '../../packages/kernel/src/core/process-census.js';
import {
  COORDINATOR,
} from '../config.js';
import {
  Refused,
} from '../refused.js';
import {
  conflictLines,
  conflictReport,
} from '../rigor-conflicts.js';
import {
  rigorDraftCommand,
} from '../rigor-draft.js';
import {
  draftConflictSplits,
} from '../rigor-splits.js';
import {
  draftQualityRows,
  rigorQualityCommand,
} from '../rigor-quality-draft.js';
import {
  rigorLines,
  rigorReport,
} from '../board-rigor.js';
import {
  context,
  ordered,
  reserveRow,
  whoAmI,
  withBoard,
} from '../cli.js';

/** Run `pullboard rigor` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  if ((values['draft-splits'] || values['draft-quality']) && first) throw new Refused('USAGE', 'use pullboard rigor --draft-splits or --draft-quality without a subcommand');
  if (first === 'quality') { if (second || rest.length) throw new Refused('USAGE', 'pullboard rigor quality [--base <commit>] [--rule <key>] [--budget <lines>]'); const ctx = context(io); return rigorQualityCommand(io, { values }, { root: ctx.info.root, config: ctx.config }); }
  if (first === 'draft') { const ctx = context(io); return rigorDraftCommand(io, { second, rest, values }, { root: ctx.info.root, config: ctx.config, parseProcessCensus, read: () => withBoard(ctx, (board) => ({ events: store.events(board), actor: whoAmI(ctx, board).id })), reserve: (row) => reserveRow(ctx, row, true), propose: (row, evidence) => withBoard(ctx, async (board) => ordered(ctx, board, 'proposeSentinel', [{ agentId: whoAmI(ctx, board).id, row, evidence }])) }); }
  if (first || second || rest.length) throw new Refused('USAGE', 'pullboard rigor takes no arguments; to draft a rule: pullboard rigor draft <key> "<rule>" --check "<command>" --red <commit> --green <commit>');
  const ctx = context(io);
  const report = withBoard(ctx, (board) => { const history = store.events(board); return { ...rigorReport(history, { person: store.PERSON, root: ctx.info.root }), ...conflictReport(history) }; });
  if (values['draft-quality']) report.qualityDrafts = await draftQualityRows(ctx, { read: () => withBoard(ctx, (board) => ({ coordinator: whoAmI(ctx, board).id === COORDINATOR, rows: store.rowDrafts(board), decisions: store.rowDecisions(board) })), reserve: row => reserveRow(ctx, row, true) });
  if (values['draft-splits']) report.splitDrafts = await draftConflictSplits(ctx, report, { read: () => withBoard(ctx, (board) => ({ coordinator: whoAmI(ctx, board).id === COORDINATOR, rows: store.rowDrafts(board), decisions: store.rowDecisions(board) })), reserve: row => reserveRow(ctx, row, true) });
  io.result?.(report);
  for (const line of [...rigorLines(report), ...conflictLines(report)]) io.say(line);
  for (const draft of report.splitDrafts ?? []) io.say(`${draft.id}: draft split proposal; person approval required`);
  for (const draft of report.qualityDrafts ?? []) io.say(`${draft.id}: draft quality rule, switched off until the person approves it`);
  return 0;
}
