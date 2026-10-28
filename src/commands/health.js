/** The pullboard health command, in its own module so an item adding another command never edits these lines. */
import { existsSync } from 'node:fs';
import {
  boardHealth,
  healthLines,
} from '../health.js';
import {
  context,
} from '../cli.js';
import { openBoardReadOnly } from '../board.js';
import { HEALTH_SENTINEL_ENGINE } from '../health-receipts.js';
import { readBlocks } from '../blocks.js';
import { rigorReport } from '../rigor.js';
import { dispatchHealth } from '../dispatch-health.js';

/** Run `pullboard health` and return its exit code. */
export function run(io) {
  const ctx = context(io);
  const report = boardHealth(ctx.file, { root: ctx.info.root, config: ctx.config, now: ctx.clock.now(), dispatchHealth });
  report.blocks = blockReport(readBlocks(ctx.info.commonDir, { since: new Date(ctx.clock.now().getTime() - 86_400_000) }), seatsByPath(ctx.file));
  io.result?.(report);
  for (const line of healthLines(report)) io.say(line);
  for (const line of blockLines(report.blocks)) io.say(line);
  return report.stuck.length ? 1 : 0;
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
