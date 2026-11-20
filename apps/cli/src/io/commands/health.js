import { recentReceipts } from '../../../../../packages/gate/heavy.js';
import { runnerLossHealth } from '../../logic/runner/loss.js';
import { runnerLossLines } from '../../logic/runner/loss.js';
import { maintenanceTimerHealth } from '../worktree/maintenance/scheduler.js';
import { flakeQuarantines } from '../../../../../packages/flakes/index.js';
import { toolBuildHealth } from '../pinned/tool/build.js';
import { newestEligibleToolBuild } from '../pinned/tool/publish.js';
import { toolBuildLocation } from '../pinned/tool/build.js';
import { unfinishedFolders } from '../item/folder.js';
import { fileURLToPath } from 'node:url';
/** The pullboard health command, in its own module so an item adding another command never edits these lines. */
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import {
  boardHealth,
  healthLines,
  slowHoldLines,
} from '../../../../../packages/health/index.js';
import {
  context,
} from '../entry.js';
import { holdLogRows } from '../../../../../packages/store/index.js';
import { openBoardReadOnly } from '../../../../../packages/store/index.js';
import { HEALTH_SENTINEL_ENGINE } from '../../../../../packages/store/index.js';
import { readBlocks } from '../../../../../packages/items/index.js';
import { rigorReport } from '../../../../../packages/store/index.js';
import { dispatchHealth } from '../../../../../packages/sentinels/index.js';
import { readGitSyncRepairs } from '../../../../../packages/sync/index.js';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { machineLoadVerdict } from '../../../../../packages/resources/index.js';
import { runnerLeaseHealth } from '../../../../../packages/resources/index.js';
import { healthDiskFloorGb } from '../../../../../packages/config/index.js';
import { diskFloorFinding } from '../health/disk.js';
import { duplicateRunnerPlaces } from '../../../../../packages/api/index.js';

const fs = fileSystemAdapter();

/** Run `pullboard health` and return its exit code. */
export async function run(io, { values = {}, statfs } = {}) {
  const ctx = context(io);
  const report = boardHealth(ctx.file, { root: ctx.info.root, config: ctx.config, now: ctx.clock.now(), dispatchHealth, machineSettings: loadMachineSettings() });
  report.runnerTransportLosses = runnerLossHealth(recentReceipts(ctx.info.root, ctx.clock.now().getTime()), ctx.clock.now().getTime());
  report.toolBuild = toolBuildHealth(ctx.info.root, fileURLToPath(new URL('../../../../../', import.meta.url)), ctx.clock.now().getTime());
  const location = toolBuildLocation(ctx.info.root);
  const eligible = location ? newestEligibleToolBuild(location, { now: ctx.clock.now().getTime() }) : null;
  report.toolBuild.newestEligible = eligible ? { commit: eligible.commit, gatedAt: eligible.gatedAt,
    ageMs: Math.max(0, ctx.clock.now().getTime() - Date.parse(eligible.gatedAt)) } : null;
  report.gitSyncRepairs = readGitSyncRepairs(ctx.info.root);
  report.autoQuarantines = automaticQuarantines(ctx.file, ctx.clock);
  const runnerHealth = runnerLeaseHealth(ctx.clock.now().getTime());
  report.overdueRunnerLeases = runnerHealth.filter(row => row.deadline !== undefined);
  report.runnerLifecycleProblems = runnerHealth.filter(row => row.problem);
  report.runnerDuplicates = duplicateRunnerPlaces(ctx.clock.now().getTime());
  report.dirtyWorktrees = [];
  if (ctx.config.worktreeMaintenance?.enabled === true) {
    const { maintenanceHealth } = await import('../worktree/maintenance.js');
    const { readMaintenanceSnapshot } = await import('../worktree/maintenance/command.js');
    report.maintenanceTimer = maintenanceTimerHealth(ctx.info.commonDir);
    report.dirtyWorktrees = maintenanceHealth(ctx.info.commonDir, await readMaintenanceSnapshot(ctx), ctx.clock.now().getTime());
  }
  report.machineLoad = machineLoadVerdict(loadMachineSettings());
  report.lowDisk = diskFloorFinding(ctx.info.root, healthDiskFloorGb(), statfs);
  report.unfinishedFolders = unfinishedFolders(ctx.info.root, seatsByPath(ctx.file));
  report.blocks = blockReport(readBlocks(ctx.info.commonDir, { since: new Date(ctx.clock.now().getTime() - 86_400_000) }), seatsByPath(ctx.file));
  io.result?.(report);
  if (report.maintenanceTimer) {
    const timer = report.maintenanceTimer;
    io.say(`maintenance timer: ${timer.state}; key ${timer.key ?? 'unknown'}; pid ${timer.pid ?? 'unknown'}; last run ${timer.lastRun?.completedAt ?? 'unknown'}${timer.cause ? '; ' + timer.cause : ''}`);
  }
  for (const line of healthLines(report)) io.say(line);
  for (const line of slowHoldLines(holdLogRows(), realBoardFile(ctx.file), { now: ctx.clock.now().getTime() })) io.say(line);
  for (const line of runnerLossLines(report.runnerTransportLosses)) io.say(line);
  if (report.toolBuild.enabled) io.say(report.toolBuild.build
    ? `Pinned tool build ${report.toolBuild.build.commit}; age ${Math.floor(report.toolBuild.ageMs / 1000)}s; running ${report.toolBuild.runningCommit ?? 'live installation'}`
    : 'Pinned tool build: not published; coordinator must promote a gated build');
  if (report.toolBuild.newestEligible) io.say(`Newest eligible tool build ${report.toolBuild.newestEligible.commit}; gate age ${Math.floor(report.toolBuild.newestEligible.ageMs / 1000)}s`);
  for (const lease of report.overdueRunnerLeases) io.say(`runner execution deadline ${new Date(lease.deadline).toISOString()} passed; holder pid ${lease.pid}${lease.item ? ` item #${lease.item}` : ''}; controller pid ${lease.controllerPid}; ${lease.repo}`);
  for (const lease of report.runnerLifecycleProblems) io.say(`runner lifecycle observation unavailable; holder pid ${lease.pid}${lease.item ? ` item #${lease.item}` : ''}; ${lease.problem}; ${lease.repo}`);
  for (const place of report.runnerDuplicates) io.say(`RUNNER_DUPLICATE: runners ${place.runners.join(' and ')} claim from host ${place.host}, runner folder ${place.root}; on the host, stop the older service (pullboard runner list shows how it was installed)`);
  for (const entry of report.autoQuarantines) io.say(`Automatic quarantine: ${entry.file} :: ${entry.name}; repair #${entry.item} must land`);
  for (const repair of report.gitSyncRepairs) io.say('Git sync recovery: ' + JSON.stringify(repair));
  io.say(report.machineLoad.line);
  if (report.lowDisk) io.say(report.lowDisk.line);
  for (const line of blockLines(report.blocks, { detail: Boolean(values.detail) })) io.say(line);
  for (const row of report.dirtyWorktrees) io.say(row.kind === 'withdrawal-retained'
    ? `withdrawal cleanup deferred for #${row.item}: ${JSON.stringify(row.path)}; ${row.reason}`
    : `worktree has uncommitted work since ${row.since} without a live seat: ${JSON.stringify(row.path)}`);
  for (const row of report.unfinishedFolders) io.say(`item folder with an unfinished ${row.operation}: ${JSON.stringify(row.path)}; seat ${row.seat ?? 'unregistered'}, #${row.item}; finish or abort it there`);
  return report.stuck.length || report.unfinishedFolders.length || report.autoQuarantines.length || report.overdueRunnerLeases.length || report.runnerLifecycleProblems.length || report.runnerDuplicates.length || report.dirtyWorktrees.length ? 1 : 0;

}

/** Each seat's id by its worktree path, so a block names who was stopped; a missing board names none. */
function seatsByPath(file) {
  if (!fs.exists(file)) return new Map();
  const db = openBoardReadOnly(file);
  try { return new Map(db.prepare('SELECT agent_id, agent_path FROM agent').all().map(seat => [seat.agent_path, seat.agent_id])); }
  finally { db.close(); }
}

/**
 * The last day's blocks by code with counts, who was stopped, who can clear them, and a drafted
 * item for each code that repeated. Repeats are judged by Rigor's own repeat detection: each block
 * is read as a sentinel observation of the cause refusal:<CODE>, the shape Rigor already counts,
 * so a block repeats exactly when Rigor would call that cause repeated [D1,C6].
 *
 * @param {any[]} blocks
 * @param {Map<string, string>} seats
 */
export function blockReport(blocks, seats = new Map()) {
  const byCode = new Map();
  for (const block of blocks) {
    const entry = byCode.get(block.code) ?? { code: block.code, count: 0, audience: block.audience, reason: block.reason, step: block.step, commands: [], who: [], last: block.at };
    entry.count += 1;
    entry.last = block.at;
    const who = block.by === 'agent' ? seats.get(block.path) ?? 'an agent' : block.by;
    if (!entry.commands.includes(block.command)) entry.commands.push(block.command);
    if (!entry.who.includes(who)) entry.who.push(who);
    byCode.set(block.code, entry);
  }
  const events = blocks.map(block => ({ event_kind: 'health-failure', event_by: 'sentinel', item_id: null,
    event_detail: JSON.stringify({ cause: `refusal:${block.code}`, engine: HEALTH_SENTINEL_ENGINE }) }));
  const repeated = rigorReport(events, { person: 'person' }).causes.map(cause => cause.key.slice('refusal:'.length));
  const codes = [...byCode.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const drafts = codes.filter(entry => repeated.includes(entry.code)).map((entry) => {
    const title = `Pullboard blocked ${entry.count} requests in a day with ${entry.code}`;
    const brief = `${entry.commands.join(', ')} stopped ${entry.who.join(', ')}: ${entry.reason}. Step given: ${entry.step}. Make the block unnecessary or clear it on its own.`;
    const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
    return { cause: `refusal:${entry.code}`, count: entry.count, lane: 'coordinator', title, brief,
      command: `pullboard add coordinator ${quote(title)} --brief ${quote(brief)}` };
  });
  return { window: '1d', codes, drafts };
}

/** The block report as lines: one per code with its count, then each drafted item; none on a quiet day [C6]. */
export function blockLines({ codes, drafts }, { detail = true } = {}) {
  // A quiet day adds nothing, so a clear board still reads as one line.
  if (!codes.length) return [];
  const clears = { person: 'the person', coordinator: 'the coordinator', agent: 'the agent that ran it' };
  return [`blocks in the last day: ${codes.reduce((sum, entry) => sum + entry.count, 0)}`,
    ...codes.map(entry => `  ${entry.code} ${entry.count}x on ${entry.commands.join(', ')}, stopped ${entry.who.join(', ')}; ${clears[entry.audience] ?? 'the agent'} clears it: ${entry.step}`),
    ...drafts.map(draft => detail ? `  repeated, draft an item: ${draft.command}` : `  repeated ${draft.cause}: coordinator item draft available with --detail`)];
}

/** Read active automatic quarantines without opening a mutable board or exposing private log bytes; the clock lets each item's stage be read. */
function automaticQuarantines(file, clock) {
  if (!fs.exists(file)) return [];
  const db = openBoardReadOnly(file);
  try { return flakeQuarantines({ db, clock }).filter(entry => entry.autoSubmit && entry.status === 'quarantined'); }
  finally { db.close(); }
}

/** The board file's real path, which is how the hold log names it; the given path when it cannot be resolved. */
function realBoardFile(file) {
  try { return fs.realpath(file); } catch { return file; }
}
