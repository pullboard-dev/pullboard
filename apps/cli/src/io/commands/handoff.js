/** Record a replacement on the board without pretending to transfer a chat's private context [B3,N19]. */
import * as store from '../../../../../packages/store/index.js';
import { context } from '../entry.js';
import { idArg } from '../entry.js';
import { ordered } from '../entry.js';
import { whoAmI } from '../entry.js';
import { withBoard } from '../entry.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { itemHandoff } from '../../../../../packages/state/light.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { recordCheckpoint } from '../seat-checkpoint.js';

const STILL_TO_WRITE = ['what you own and what is unfinished', 'principles and taste behind decisions',
  'open threads, questions and next steps', 'files outside this repository and where they are',
  'anything only this chat knows; Pullboard cannot transfer private chat context'];

/** Build the outgoing seat's current board card without executing its session or its work. */
function card(board, outgoing) {
  const agent = store.agentById(board, outgoing);
  const items = store.listItems(board, { all: true });
  const claims = items.filter(item => item.item_owner === outgoing && item.item_status === 'claimed');
  const moves = board.db.prepare('SELECT * FROM event WHERE event_by=? ORDER BY event_id DESC LIMIT 20').all(outgoing).reverse();
  const shouts = store.allShouts(board);
  const asks = shouts.filter(row => row.shout_decision && (row.shout_from === outgoing || row.shout_to === outgoing || row.shout_to === agent.agent_lane))
    .map(ask => ({ ask, answers: shouts.filter(row => row.shout_answers === ask.shout_id) }));
  const branch = tryGit(agent.agent_path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const state = tryGit(agent.agent_path, ['status', '--porcelain']);
  return { agent: outgoing, lane: agent.agent_lane, claims, moves, asks,
    worktree: { path: agent.agent_path, branch: branch.status === 0 ? branch.stdout : null,
      changes: state.status === 0 ? state.stdout : null, unavailable: branch.status !== 0 || state.status !== 0 } };
}

/** Print existing facts and the remaining checklist, ending with a post-takeover-safe sign-off. */
function print(io, handoff, resume, facts) {
  const signoff = `pullboard shout --item ${handoff.item} "Hand-off complete; ask any remaining questions here."`;
  io.result?.({ handoff, resume, facts, stillToWrite: STILL_TO_WRITE, signoff });
  io.say(`Hand-off #${handoff.item}: ${handoff.outgoing}${handoff.incoming ? ` → ${handoff.incoming} at ${handoff.takenAt}` : ' is preparing a replacement'}`);
  io.say(`Worktree: ${resume.worktree.path}; branch ${resume.worktree.branch ?? 'unavailable'}`);
  io.say(resume.worktree.unavailable ? 'Worktree state could not be read; record its last known state.' : `Uncommitted paths:\n${resume.worktree.changes || '(none)'}`);
  io.say(`Claims: ${resume.claims.map(item => `#${item.item_id} ${item.item_title}`).join('; ') || '(none)'}`);
  io.say('Recent moves:');
  for (const move of resume.moves) io.say(`  ${move.event_at} ${move.event_kind}${move.item_id ? ` #${move.item_id}` : ''}`);
  io.say('Asks and answers:');
  for (const { ask, answers } of resume.asks) {
    io.say(`  #${ask.shout_id}: ${ask.shout_text}`);
    for (const answer of answers) io.say(`    ${answer.shout_from}: ${answer.shout_text}`);
    if (!answers.length) io.say('    (open)');
  }
  io.say('Recorded hand-off facts:');
  for (const fact of facts) io.say(`  ${fact.by} ${fact.kind}: ${fact.text}`);
  io.say('Facts still to write before you leave:');
  for (const subject of STILL_TO_WRITE) io.say(`  pullboard fact ${handoff.item} note "${subject}"`);
  io.say('After takeover, only shouts on this item remain available to the outgoing agent. Sign off with:');
  io.say(signoff);
}

/** Create/find a hand-off, or atomically record an incoming agent's timed takeover. */
export async function run(io, { first, second, rest, values }) {
  if (first || second || rest.length) throw new Refused('USAGE', 'use pullboard handoff, or pullboard handoff --take <id> from the incoming agent worktree');
  const ctx = context(io);
  return withBoard(ctx, async board => {
    const me = whoAmI(ctx, board);
    if (ctx.info.isMain) throw new Refused('HANDOFF_WORKTREE', 'run pullboard handoff from an agent worktree; the main checkout has its separate coordinator takeover flow');
    const handoff = values.take === undefined
      ? await ordered(ctx, board, 'openHandoff', [{ agentId: me.id }])
      : await ordered(ctx, board, 'takeHandoff', [{ agentId: me.id, item: idArg(values.take) }]);
    const current = itemHandoff(board, handoff.item);
    if (values.take !== undefined && current?.incoming === me.id && current.takenAt && ctx.config.worktreeMaintenance?.enabled === true) {
      const outgoing = store.agentById(board, current.outgoing);
      const { cleanupMaintenanceLifecycle } = await import('../worktree/maintenance/command.js');
      await cleanupMaintenanceLifecycle(ctx, me.id, { path: outgoing.agent_path, agent: current.outgoing,
        item: current.item, retired: true, completedTakeover: true });
    }
    const resume = card(board, current.outgoing);
    // seat.checkpoints (off by default): the outgoing seat records its five-part checkpoint on the hand-off item [C7,#8552].
    if (values.take === undefined) await recordCheckpoint(ctx, board, { item: handoff.item, agent: me.id, moment: 'handoff', parts: {
      done: resume.moves.slice(-5).map(move => `${move.event_kind}${move.item_id ? ` #${move.item_id}` : ''}`),
      left: resume.claims.map(item => `#${item.item_id} ${item.item_title}`),
      decisions: resume.asks.filter(({ answers }) => !answers.length).map(({ ask }) => `open ask #${ask.shout_id}: ${ask.shout_text}`),
      evidence: [`worktree ${resume.worktree.path} on ${resume.worktree.branch ?? 'unavailable'}`] } }, ordered);
    print(io, current, resume, store.itemThread(board, handoff.item).filter(row => row.type === 'fact'));
    return 0;
  });
}
