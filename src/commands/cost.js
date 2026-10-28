/** Shared item, lane, milestone and model usage totals [N2]. */
import { costTotals } from '../cost.js';
import { recordClaudeCost } from '../cost-ledger.js';
import { publishUsage } from '../cost-checkpoint.js';
import { readStdin } from '../cli-support.js';
import { context } from '../cli.js';
import { withBoard } from '../cli.js';
import { withBoardRead } from '../cli.js';
import { whoAmI } from '../cli.js';
import { Refused } from '../refused.js';

/** Render incomplete totals explicitly while preserving useful known partial subtotals. */
function amount(total, name, known) {
  return total[name] === null ? `unknown (known ${total[known]})` : String(total[name]);
}

/** Refresh only when requested; a plain cost query never writes or reads native transcripts. */
export async function run(io, { first, values }) {
  const ctx = context(io);
  if (first && !['refresh', 'record'].includes(first)) throw new Refused('USAGE', 'run pullboard cost, pullboard cost refresh, or pipe a native Claude statusline report to pullboard cost record');
  if (first) {
    if (first === 'record') {
      let payload;
      try { payload = JSON.parse(await readStdin(io.stdin)); } catch { throw new Refused('USAGE_REPORT', 'pipe a native Claude statusline JSON report to pullboard cost record'); }
      recordClaudeCost(ctx.info, payload);
    }
    await withBoard(ctx, async (board) => { const me = whoAmI(ctx, board); await publishUsage(ctx, board, { agent: me.id, operation: 'refresh' }); });
  }
  const totals = withBoardRead(ctx, (board) => costTotals(board));
  if (values.json) io.result(totals);
  else {
    for (const group of ['items', 'lanes', 'milestones', 'models']) {
      io.say(`${group}:`);
      for (const total of totals[group]) {
        const key = total.item ?? total.lane ?? total.milestone ?? total.model;
        io.say(`  ${key}: input ${amount(total, 'inputTokens', 'knownInputTokens')}, output ${amount(total, 'outputTokens', 'knownOutputTokens')}, estimated USD ${amount(total, 'costUSD', 'knownCostUSD')}, ${total.wallMs} ms`);
      }
    }
    io.say('shared sessions (per-item split unknown):');
    for (const shared of totals.sharedSessions) io.say(`  ${shared.id}: seats ${shared.seats.join(', ')}, input ${amount(shared, 'inputTokens', 'knownInputTokens')}, output ${amount(shared, 'outputTokens', 'knownOutputTokens')}, estimated USD ${amount(shared, 'costUSD', 'knownCostUSD')}`);
  }
  return 0;
}
