import { flakeQuarantines } from '../quarantine.js';
/** The pullboard health command, in its own module so an item adding another command never edits these lines. */
import { existsSync } from 'node:fs';
import {
  boardHealth,
  healthLines,
} from '../../packages/health/index.js';
import {
  context,
} from '../cli.js';
import { openBoardReadOnly } from '../board.js';
import { HEALTH_SENTINEL_ENGINE } from '../board-health-receipts.js';
import { readBlocks } from '../blocks.js';
import { rigorReport } from '../board-rigor.js';
import { dispatchHealth } from '../dispatch-health.js';
import { readGitSyncRepairs } from '../git-sync-files.js';
import { runnerLeaseHealth } from '../../packages/resources/index.js';

/** Run `pullboard health` and return its exit code. */
export async function run(io) {
  const ctx = context(io);
  const report = boardHealth(ctx.file, { root: ctx.info.root, config: ctx.config, now: ctx.clock.now(), dispatchHealth });
  report.gitSyncRepairs = readGitSyncRepairs(ctx.info.root);
  report.autoQuarantines = automaticQuarantines(ctx.file);
  const runnerHealth = runnerLeaseHealth(ctx.clock.now().getTime());
  report.overdueRunnerLeases = runnerHealth.filter(row => row.deadline !== undefined);
  report.runnerLifecycleProblems = runnerHealth.filter(row => row.problem);
  report.dirtyWorktrees = [];
  if (ctx.config.worktreeMaintenance?.enabled === true) {
    const { maintenanceHealth } = await import('../worktree-maintenance.js');
    const { readMaintenanceSnapshot } = await import('../worktree-maintenance-command.js');
    report.dirtyWorktrees = maintenanceHealth(ctx.info.commonDir, await readMaintenanceSnapshot(ctx), ctx.clock.now().getTime());
  }
  report.blocks = blockReport(readBlocks(ctx.info.commonDir, { since: new Date(ctx.clock.now().getTime() - 86_400_000) }), seatsByPath(ctx.file));
  io.result?.(report);
  for (const line of healthLines(report)) io.say(line);
  for (const lease of report.overdueRunnerLeases) io.say(`runner execution deadline ${new Date(lease.deadline).toISOString()} passed; holder pid ${lease.pid}${lease.item ? ` item #${lease.item}` : ''}; controller pid ${lease.controllerPid}; ${lease.repo}`);
  for (const lease of report.runnerLifecycleProblems) io.say(`runner lifecycle observation unavailable; holder pid ${lease.pid}${lease.item ? ` item #${lease.item}` : ''}; ${lease.problem}; ${lease.repo}`);
  for (const entry of report.autoQuarantines) io.say(`Automatic quarantine: ${entry.file} :: ${entry.name}; repair #${entry.item} must land`);
  for (const repair of report.gitSyncRepairs) io.say('Git sync recovery: ' + JSON.stringify(repair));
  for (const line of blockLines(report.blocks)) io.say(line);
  for (const row of report.dirtyWorktrees) io.say(`worktree has uncommitted work since ${row.since} without a live seat: ${JSON.stringify(row.path)}`);
  return report.stuck.length || report.autoQuarantines.length || report.overdueRunnerLeases.length || report.runnerLifecycleProblems.length || report.dirtyWorktrees.length ? 1 : 0;

}

/** Each seat's id by its worktree path, so a block names who was stopped; a missing board names none. */
function seatsByPath(file) {
  if (!existsSync(file)) return new Map();
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
export function blockLines({ codes, drafts }) {
  // A quiet day adds nothing, so a clear board still reads as one line.
  if (!codes.length) return [];
  const clears = { person: 'the person', coordinator: 'the coordinator', agent: 'the agent that ran it' };
  return [`blocks in the last day: ${codes.reduce((sum, entry) => sum + entry.count, 0)}`,
    ...codes.map(entry => `  ${entry.code} ${entry.count}x on ${entry.commands.join(', ')}, stopped ${entry.who.join(', ')}; ${clears[entry.audience] ?? 'the agent'} clears it: ${entry.step}`),
    ...drafts.map(draft => `  repeated, draft an item: ${draft.command}`)];
}

/** Read active automatic quarantines without opening a mutable board or exposing private log bytes. */
function automaticQuarantines(file) {
  if (!existsSync(file)) return [];
  const db = openBoardReadOnly(file);
  try { return flakeQuarantines({ db }).filter(entry => entry.autoSubmit && entry.status === 'quarantined'); }
  finally { db.close(); }
}
