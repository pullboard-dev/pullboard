import { idleSkipMinutes } from '../../../../../packages/stats/index.js';
import { buildTimeStats } from '../../../../../packages/stats/index.js';
import { buildTimeLines } from '../../../../../packages/stats/index.js';
import { criterionCells } from '../../../../../packages/items/index.js';
import { criterionSize } from '../../../../../packages/items/index.js';
import { appendTimeCheckpoint } from '../../../../../packages/stats/index.js';
import { checkpointLine } from '../../../../../packages/stats/index.js';
import { readTimeHistory } from '../../../../../packages/stats/index.js';
import { timeLines } from '../../../../../packages/stats/index.js';
import { timeStats } from '../../../../../packages/stats/index.js';
import { weeklyDue } from '../../../../../packages/stats/index.js';
import { join } from 'node:path';
import { runUtilization } from './stats/utilization.js';
import { coordinatorActions } from '../../../../../packages/stats/index.js';
import { coordinatorActionLines } from '../../../../../packages/stats/index.js';
import { runDemand } from './stats/demand.js';
import { runHealth } from './stats/health.js';
import { runLag } from './stats/lag.js';
import { runAgents } from './stats/agents.js';
import { pipelineLimit } from '../../../../../packages/stats/index.js';
import { pipelineStats } from '../../../../../packages/stats/index.js';
import { pipelineLines } from '../../../../../packages/stats/index.js';
import { pipelinePerHour } from '../../../../../packages/stats/index.js';
import { pipelinePerHourLines } from '../../../../../packages/stats/index.js';
import { movesStats } from '../../../../../packages/stats/index.js';
import { movesLines } from '../../../../../packages/stats/index.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { localUsage } from '../../../../../packages/config/index.js';
import { dollarText } from '../../../../../packages/config/index.js';
import { runRunners } from './stats/runners.js';
import { diskLines } from '../disk/use.js';
import { diskUse } from '../disk/use.js';
import { pruneDisk } from '../disk/use.js';
import { pruneLines } from '../disk/use.js';
import { refusingBadPolicy } from '../disk/use.js';
/** The pullboard stats command, in its own module so an item adding another command never edits these lines. */
import { costTotals } from '../../../../../packages/stats/index.js';
import { boardHoldLines } from '../../../../../packages/store/index.js';
import { boardHoldStats } from '../../../../../packages/store/index.js';
import { readBoardHoldBaseline } from '../../../../../packages/store/index.js';
import { publicUsage } from '../../../../../packages/stats/index.js';
import { counterProofStats } from '../../../../../packages/verify/index.js';
import {
  barStatsLines,
} from '../../../../../packages/verify/index.js';
import * as store from '../../../../../packages/store/index.js';
import { caughtLines } from '../../../../../packages/items/index.js';
import * as gateReceipt from '../../../../../packages/gate/index.js';
import { readRunnerStage } from '../../../../runner/index.js';
import {
  compareFlowWindows,
  flowLines,
  flowReportLines,
  flowStats,
} from '../../../../../packages/stats/index.js';
import {
  comparisonLines,
  flowWindowLines,
  flowWindowMinutes,
} from '../../../../../packages/stats/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  proofStats,
} from '../../../../../packages/stats/index.js';
import {
  agentDisplayName,
  context,
  withBoard,
} from '../entry.js';

/** Run `pullboard stats` and return its exit code. */
export function run(io, { first, second, rest, values }) {
  if (first === 'runners' && values.demand) return runDemand(io, { second, rest, values });
  if (first === 'runners' && values.health) return runHealth(io, context(io), { second, rest, values });
  if (first === 'runners' && (values.lag || values['main-lag'])) return runLag(io, context(io), { second, rest, values });
  if (first === 'runners' && values.utilization) return runUtilization(io, { second, rest, values });
  const ctx = context(io);
  if (first === 'agents') return runAgents(io, ctx, { second, rest, values });
  if (first !== undefined && !['pipeline', 'moves', 'time', 'disk', 'runners'].includes(first)) throw new Refused('USAGE', 'use pullboard stats, pullboard stats disk [--prune], pullboard stats runners, pullboard stats pipeline, pullboard stats moves --limit 20, or pullboard stats time --window 7d');
  if (values.transcripts !== undefined && first !== 'moves') throw new Refused('USAGE', '--transcripts belongs to pullboard stats moves');
  if (values.prune && first !== 'disk') throw new Refused('USAGE', '--prune belongs to pullboard stats disk');
  if (first === 'runners') return runRunners(io, ctx, { second, rest, values });
  if (first === 'disk') {
    if (second !== undefined || rest?.length) throw new Refused('USAGE', 'show disk use with pullboard stats disk, or age out old raw logs and archives with pullboard stats disk --prune [--dry-run]');
    const dir = join(ctx.info.commonDir, 'pullboard');
    const pruned = values.prune ? refusingBadPolicy(() => pruneDisk(dir, { now: ctx.clock.now().getTime(), dryRun: Boolean(values['dry-run']) }), Refused) : null;
    const disk = refusingBadPolicy(() => diskUse(dir, { now: ctx.clock.now().getTime() }), Refused);
    io.result?.({ disk, ...(pruned ? { pruned } : {}) });
    if (pruned) for (const line of pruneLines(pruned)) io.say(line);
    for (const line of diskLines(disk)) io.say(line);
    return 0;
  }
  if (first === 'time') {
    if (second !== undefined || rest?.length || values.since !== undefined || values.compare) throw new Refused('USAGE', 'show where item time went with pullboard stats time --window 7d [--checkpoint weekly|release]');
    const kind = values.checkpoint;
    if (kind !== undefined && !['weekly', 'release'].includes(kind)) throw new Refused('USAGE', 'record a checkpoint with --checkpoint weekly or --checkpoint release');
    const days = flowWindowMinutes(values.window ?? '7d') / 1440;
    const now = ctx.clock.now().getTime();
    const receipts = gateReceipt.retainedReceipts(ctx.info.root, { from: '1970-01-01T00:00:00.000Z', to: new Date(now + 1).toISOString() });
    const catalog = criterionCells(ctx.info.root);
    const time = withBoard(ctx, board => {
      const history = store.events(board);
      const phases = timeStats(history, { now, days, receipts });
      const builds = buildTimeStats(history, store.listItems(board, { all: true }), catalog, criterionSize);
      return { ...phases, builds };
    });
    let checkpoint = null;
    if (kind) {
      const file = join(ctx.info.commonDir, 'pullboard', 'stats-history.jsonl');
      if (kind === 'release' || weeklyDue(readTimeHistory(file), now)) { appendTimeCheckpoint(file, checkpointLine(time, { reason: kind })); checkpoint = file; }
    }
    io.result?.({ time, checkpoint });
    for (const line of timeLines(time)) io.say(line);
    for (const line of buildTimeLines(time.builds)) io.say(line);
    if (kind) io.say(checkpoint ? `checkpoint recorded in ${checkpoint}` : 'a weekly checkpoint is not due yet');
    return 0;
  }
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
  const { stats, agents, window, comparison, usage, coordinator, idleSkips, pipelineHour } = withBoard(ctx, (board) => {
    // Keep counters and optional raw-history window on the same read snapshot while other seats append.
    if (windowMinutes !== undefined) board.db.exec('SAVEPOINT stats_window_read');
    try {
      const stats = proofStats(board, { since: values.since, now }, { events: store.events, counterProofStats });
      // The lifecycle projection validates the date range before capacity reads use its bounds.
      const history = store.events(board);
      const idleSkips = idleSkipMinutes(history, now);
      const pipelineHour = windowMinutes === undefined ? undefined : pipelinePerHour(history, { now, windowMinutes });
      const window = windowMinutes === undefined ? undefined
        : flowStats(history, null, now, stats, { windowMinutes }).window;
      const comparison = values.compare ? compareFlowWindows(history, { now, windowMinutes, complete: true }) : undefined;
      if (window) window.executionCapacity = readRunnerStage(ctx.info.root, { from: window.since, to: window.until });
      const coordinator = coordinatorActions(board, { since: window?.since ?? stats.since ?? undefined, until: new Date(now).toISOString() });
      return { stats, coordinator, idleSkips, agents: store.listAgents(board), usage: localUsage(costTotals(board, prices), publicUsage), ...(pipelineHour ? { pipelineHour } : {}), ...(window ? { window } : {}), ...(comparison ? { comparison } : {}) };
    } finally {
      if (windowMinutes !== undefined) board.db.exec('RELEASE stats_window_read');
    }
  });
  const waits = gateReceipt.gateWaitStats(ctx.info.root, now);
  const boardHolds = boardHoldStats({ since: window?.since ?? stats.since ?? undefined, until: now });
  const holdBaseline = readBoardHoldBaseline();
  boardHolds.allowance = { ...holdBaseline, status: holdBaseline.allowancePerDay === null ? 'unmeasured'
    : boardHolds.todayCount > holdBaseline.allowancePerDay ? 'exceeded'
      : !boardHolds.available || boardHolds.truncated || boardHolds.invalidLines ? 'incomplete' : 'within' };
  const disk = refusingBadPolicy(() => diskUse(join(ctx.info.commonDir, 'pullboard'), { now, maxAgeMs: 5 * 60_000 }), Refused);
  io.result?.({ stats, disk, usage, idleSkips, coordinatorActions: coordinator, gateWaits: waits.stats, testWallBudgets: waits.testWallBudgets, boardHolds, ...(pipelineHour ? { pipelineHour } : {}), ...(window ? { window } : {}), ...(comparison ? { comparison } : {}) });
  // First, so the 8192-byte human summary never withholds the answer a window was asked for.
  if (pipelineHour) for (const line of pipelinePerHourLines(pipelineHour)) io.say(line);
  io.say(`${stats.submissions} submissions · ${stats.rejections} rejections · ${(stats.rejectionShare * 100).toFixed(1)}% sent back`);
  io.say(`${stats.merged} items merged · ${stats.mergedWithoutAccept} merged without an accept`);
  io.say(`${stats.agentCount} agents · ${stats.familyCount} family buckets: ${stats.families.map((family) => `${family.name} (${family.agents} agents, ${family.moves} moves)`).join('; ') || 'none'}`);
  io.say(`agents: ${stats.agents.map((agent) => `${agentDisplayName(agents, ctx.config, agent.id)} (${agent.families.join('/')}; ${agent.moves} moves)`).join(', ') || 'none'}`);
  for (const row of stats.notesPerSubmit) io.say(`${row.seat}: ${row.notes} notes / ${row.submits} submits (${row.notesPerSubmit ?? 'unmeasured'} notes per submit)`);
  for (const row of stats.workFreeReleases) io.say(`work-free releases ${row.day}: ${row.seat} ${row.reason} ${row.count}`);
  io.say(`events: ${stats.firstEventAt ?? 'none'} to ${stats.lastEventAt ?? 'none'}${stats.since ? ` (since ${stats.since})` : ''}`);
  for (const row of idleSkips.rows) io.say(`idle last 24h: ${row.code} ${row.seatMinutes.toFixed(2)} seat-minutes`);
  for (const line of coordinatorActionLines(coordinator)) io.say(line);
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
  for (const line of diskLines(disk)) io.say(line);
  for (const group of ['items', 'lanes', 'milestones', 'models']) for (const row of usage[group]) {
    const label = row.item ?? row.lane ?? row.milestone ?? row.model;
    io.say(`usage ${group} ${label}: input ${row.inputTokens ?? 'unknown'} (fresh ${row.freshInputTokens ?? 'unknown'}, cached read ${row.cacheReadInputTokens ?? 'unknown'}, cached write ${row.cacheWriteInputTokens ?? 'unknown'}), output ${row.outputTokens ?? 'unknown'}, ${row.wallMs} ms${row.unknownReasons.length ? '; unknown: ' + row.unknownReasons.join(', ') : ''}${dollarText(row)}`);
  }
  return 0;
}
