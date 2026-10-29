/** The pullboard stats command, in its own module so an item adding another command never edits these lines. */
import { costTotals } from '../cost.js';
import { boardHoldLines } from '../board-hold-log.js';
import { boardHoldStats } from '../board-hold-log.js';
import { readBoardHoldBaseline } from '../board-hold-ratchet.js';
import { publicUsage } from '../cost-read.js';
import { counterProofStats } from '../proof-counter-read.js';
import {
  barStatsLines,
} from '../bar-corrections.js';
import * as store from '../board.js';
import { caughtLines } from '../caught.js';
import * as gateReceipt from '../gate-receipt.js';
import { readRunnerStage } from '../runner-stage-read.js';
import {
  compareFlowWindows,
  flowLines,
  flowReportLines,
  flowStats,
} from '../stats-flow.js';
import {
  comparisonLines,
  flowWindowLines,
  flowWindowMinutes,
} from '../stats-flow-window.js';
import {
  Refused,
} from '../refused.js';
import {
  proofStats,
} from '../stats.js';
import {
  agentDisplayName,
  context,
  withBoard,
} from '../cli.js';

/** Run `pullboard stats` and return its exit code. */
export function run(io, { values }) {
  const ctx = context(io);
  if (values.since !== undefined && values.window !== undefined) {
    throw new Refused('USAGE', 'choose either --since <date> or --window <duration>, for example pullboard stats --window 6h');
  }
  if (values.compare && values.window === undefined) throw new Refused('USAGE', 'compare adjacent windows with pullboard stats --window 4h --compare');
  const windowMinutes = values.window === undefined ? undefined : flowWindowMinutes(values.window);
  const now = ctx.clock.now().getTime();
  const { stats, agents, window, comparison, usage } = withBoard(ctx, (board) => {
    // Keep counters and optional raw-history window on the same read snapshot while other seats append.
    if (windowMinutes !== undefined) board.db.exec('SAVEPOINT stats_window_read');
    try {
      const stats = proofStats(board, { since: values.since, now }, { events: store.events, counterProofStats });
      // The lifecycle projection validates the date range before capacity reads use its bounds.
      const history = windowMinutes === undefined ? undefined : store.events(board);
      const window = history === undefined ? undefined
        : flowStats(history, null, now, stats, { windowMinutes }).window;
      const comparison = values.compare ? compareFlowWindows(history, { now, windowMinutes, complete: true }) : undefined;
      if (window) window.executionCapacity = readRunnerStage(ctx.info.root, { from: window.since, to: window.until });
      return { stats, agents: store.listAgents(board), usage: publicUsage(costTotals(board)), ...(window ? { window } : {}), ...(comparison ? { comparison } : {}) };
    } finally {
      if (windowMinutes !== undefined) board.db.exec('RELEASE stats_window_read');
    }
  });
  const waits = gateReceipt.gateWaitStats(ctx.info.root);
  const boardHolds = boardHoldStats({ since: window?.since ?? stats.since ?? undefined, until: now });
  const holdBaseline = readBoardHoldBaseline();
  boardHolds.allowance = { ...holdBaseline, status: holdBaseline.allowancePerDay === null ? 'unmeasured'
    : boardHolds.todayCount > holdBaseline.allowancePerDay ? 'exceeded'
      : !boardHolds.available || boardHolds.truncated || boardHolds.invalidLines ? 'incomplete' : 'within' };
  io.result?.({ stats, usage, gateWaits: waits.stats, boardHolds, ...(window ? { window } : {}), ...(comparison ? { comparison } : {}) });
  io.say(`${stats.submissions} submissions · ${stats.rejections} rejections · ${(stats.rejectionShare * 100).toFixed(1)}% sent back`);
  io.say(`${stats.merged} items merged · ${stats.mergedWithoutAccept} merged without an accept`);
  io.say(`${stats.agentCount} agents · ${stats.familyCount} family buckets: ${stats.families.map((family) => `${family.name} (${family.agents} agents, ${family.moves} moves)`).join('; ') || 'none'}`);
  io.say(`agents: ${stats.agents.map((agent) => `${agentDisplayName(agents, ctx.config, agent.id)} (${agent.families.join('/')}; ${agent.moves} moves)`).join(', ') || 'none'}`);
  io.say(`events: ${stats.firstEventAt ?? 'none'} to ${stats.lastEventAt ?? 'none'}${stats.since ? ` (since ${stats.since})` : ''}`);
  for (const line of barStatsLines(stats.bars)) io.say(line);
  for (const line of caughtLines(stats.caught)) io.say(line);
  for (const line of window ? flowWindowLines(window) : [...flowLines(stats.flow), ...flowReportLines(stats.flow)]) io.say(line);
  if (window?.executionCapacity) {
    const waits = window.executionCapacity.slotWait;
    /** Keep absent window timing visibly unmeasured in the human-readable summary. */
    const formatWait = value => value === null ? 'unmeasured' : `${(value / 1000).toFixed(2)}s`;
    io.say(`runner slot waits: fast ${formatWait(waits.fastQuarterMs)} · median ${formatWait(waits.medianMs)} · slow ${formatWait(waits.slowQuarterMs)} · worst ${formatWait(waits.worstMs)} (${waits.count} measured)`);
  }
  if (comparison) for (const line of comparisonLines(comparison)) io.say(line);
  for (const line of waits.lines) io.say(line);
  for (const line of boardHoldLines(boardHolds, holdBaseline)) io.say(line);
  for (const group of ['items', 'lanes', 'milestones', 'models']) for (const row of usage[group]) {
    const label = row.item ?? row.lane ?? row.milestone ?? row.model;
    io.say(`usage ${group} ${label}: input ${row.inputTokens ?? 'unknown'}, output ${row.outputTokens ?? 'unknown'}, ${row.wallMs} ms${row.unknownReasons.length ? '; unknown: ' + row.unknownReasons.join(', ') : ''}`);
  }
  return 0;
}
