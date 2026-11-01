import { pipelineLimit } from '../../packages/stats/index.js';
import { pipelineStats } from '../../packages/stats/index.js';
import { pipelineLines } from '../../packages/stats/index.js';
import { movesStats } from '../../packages/stats/index.js';
import { movesLines } from '../../packages/stats/index.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadMachineSettings } from '../../packages/config/index.js';
import { localUsage } from '../../packages/config/index.js';
import { dollarText } from '../../packages/config/index.js';
/** The pullboard stats command, in its own module so an item adding another command never edits these lines. */
import { costTotals } from '../../packages/stats/index.js';
import { boardHoldLines } from '../board-hold-log.js';
import { boardHoldStats } from '../board-hold-log.js';
import { readBoardHoldBaseline } from '../board-hold-ratchet.js';
import { publicUsage } from '../../packages/stats/index.js';
import { counterProofStats } from '../../packages/verify/index.js';
import {
  barStatsLines,
} from '../bar-corrections.js';
import * as store from '../board.js';
import { caughtLines } from '../../packages/items/index.js';
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
} from '../../packages/kernel/index.js';
import {
  proofStats,
} from '../stats.js';
import {
  agentDisplayName,
  context,
  withBoard,
} from '../cli.js';

/** Run `pullboard stats` and return its exit code. */
export function run(io, { first, second, rest, values }) {
  const ctx = context(io);
  if (first !== undefined && !['pipeline', 'moves'].includes(first)) throw new Refused('USAGE', 'use pullboard stats, pullboard stats pipeline, or pullboard stats moves --limit 20');
  if (values.transcripts !== undefined && first !== 'moves') throw new Refused('USAGE', '--transcripts belongs to pullboard stats moves');
  if (first === 'moves') {
    if (second !== undefined || rest?.length || values.since !== undefined || values.window !== undefined || values.compare) throw new Refused('USAGE', 'select landed items with pullboard stats moves --limit 20');
    const limit = pipelineLimit(values.limit);
    let transcripts;
    if (values.transcripts !== undefined) {
      try {
        const bytes = readFileSync(resolve(io.cwd, values.transcripts));
        if (bytes.length > 4 * 1024 * 1024) throw new Error('larger than 4 MiB');
        transcripts = JSON.parse(bytes.toString('utf8'));
      } catch (error) { throw new Refused('USAGE', `cannot read supplied command transcripts: ${error.message}`); }
    }
    const moves = withBoard(ctx, board => movesStats(store.events(board), { limit, transcripts }));
    io.result?.({ moves });
    for (const line of movesLines(moves)) io.say(line);
    return 0;
  }
  if (first === 'pipeline') {
    if (second !== undefined || rest?.length || values.since !== undefined || values.window !== undefined || values.compare) throw new Refused('USAGE', 'select landed items with pullboard stats pipeline --limit 20; time windows belong to pullboard stats --window');
    const limit = pipelineLimit(values.limit);
    const pipeline = withBoard(ctx, board => pipelineStats(store.events(board), { limit }));
    io.result?.({ pipeline });
    for (const line of pipelineLines(pipeline)) io.say(line);
    return 0;
  }
  const prices = loadMachineSettings().costPrices;
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
      return { stats, agents: store.listAgents(board), usage: localUsage(costTotals(board, prices), publicUsage), ...(window ? { window } : {}), ...(comparison ? { comparison } : {}) };
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
    io.say(`usage ${group} ${label}: input ${row.inputTokens ?? 'unknown'} (fresh ${row.freshInputTokens ?? 'unknown'}, cached read ${row.cacheReadInputTokens ?? 'unknown'}, cached write ${row.cacheWriteInputTokens ?? 'unknown'}), output ${row.outputTokens ?? 'unknown'}, ${row.wallMs} ms${row.unknownReasons.length ? '; unknown: ' + row.unknownReasons.join(', ') : ''}${dollarText(row)}`);
  }
  return 0;
}
