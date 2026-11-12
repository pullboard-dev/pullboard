import { AGENT_SESSION_IDS } from '../../../kernel/index.js';
import { repoInfo } from '../../../git/index.js';
import { sameCommonDir } from '../../../git/index.js';
import { isClean } from '../../../git/index.js';
import { untracked } from '../../../git/index.js';
import { bindLocalSession } from './agent/session.js';
/**
 * A seat works in its own checkout (#898). One agent session can hold seats in several checkouts (B13), and a helper
 * can start in a checkout that has no seat at all. These refusals and lines keep each claim with the checkout that
 * will do the work: an unjoined checkout is pointed at its session's seats instead of borrowing one, and an item held
 * by this session's seat elsewhere is named with that seat and its path.
 */
import { localSessionSeats } from './agent/session.js';
import { Refused } from '../../../kernel/index.js';

/** Quote a path the way the CLI's other cd lines do. */
function cdTo(path) {
  return `cd '${path.replaceAll("'", "'\\''")}' &&`;
}

/** This session's seats in other checkouts of the board, by local binding only; the caller supplies the session digest reader. */
function sessionSeats(info, agents, sessionDigest) {
  const digest = sessionDigest();
  return digest ? localSessionSeats(info, { agents, digest }).filter((seat) => seat.agent_path !== info.root) : [];
}

/**
 * The refusal for a write from a checkout with no seat. When this session has seats elsewhere it names them and the
 * command to continue there, so the checkout never claims under another checkout's seat.
 *
 * @param {{ root: string, commonDir: string }} info
 * @param {any[]} agents
 * @param {() => string | null} sessionDigest - the person cell's session digest reader, passed in so seats never load it
 */
export function unjoinedRefusal(info, agents, sessionDigest) {
  const seats = sessionSeats(info, agents, sessionDigest);
  const join = 'pullboard join <lane> --model "<model name>"';
  if (!seats.length) return new Refused('NOT_JOINED', `this worktree has not joined a lane; run ${join}`);
  const named = seats.map((seat) => `${seat.agent_id} (${seat.agent_lane} lane) in ${seat.agent_path}`).join('; ');
  return new Refused('NOT_JOINED', `this checkout has no seat, and your session's seats work in their own checkouts: ${named}`,
    `continue in that seat: ${cdTo(seats[0].agent_path)} pullboard next; or give this checkout its own seat: ${join}`);
}

/**
 * Refuse a check, submit or release in this checkout for an item one of this session's seats holds in another one.
 *
 * @param {{ root: string, commonDir: string }} info
 * @param {any[]} agents
 * @param {object} item - the item as getItem returns it; its id, status and owner are read
 * @param {string} command - The command to repeat in the holder's checkout.
 * @param {() => string | null} sessionDigest - the person cell's session digest reader
 */
export function refuseHeldElsewhere(info, agents, item, command, sessionDigest) {
  if (item.item_status !== 'claimed') return;
  const holder = sessionSeats(info, agents, sessionDigest).find((seat) => seat.agent_id === item.item_owner);
  if (!holder || info.root === `${holder.agent_path}-item-${item.item_id}`) return; // the holder's own item folder [B5]
  throw new Refused('NOT_YOURS', `#${item.item_id} is held by ${holder.agent_id} in ${holder.agent_path}, not by this checkout`,
    `${command} it from that seat's checkout: ${cdTo(holder.agent_path)} pullboard ${command} ${item.item_id}`);
}

/** The line that leads next's output when the claim belongs to a seat in another checkout. */
export function seatLeadLine(seat, item, held) {
  return `${seat.agent} (${seat.lane} lane) ${held ? 'holds' : 'now holds'} #${item.item_id} in ${seat.path}; continue there: ${cdTo(seat.path)} pullboard next`;
}

/**
 * Choose or open the matching lane seat (with `open: false`, only choose: no free seat returns `seat: null` and nothing is opened), retaining ordinary checkout ownership and lane guards.
 *
 * The CLI supplies the board readers, the session digest reader and the worktree opener as one explicit port,
 * so the seats cell never loads the board, the person cell or the CLI's commands. `repoInfoOf` reads a seat's checkout and
 * is a port so a test can name a Windows checkout whose commonDir uses the other slash spelling [C7].
 */
export async function laneSeatContext(ctx, board, me, item, seats, contextAt, { store, sessionDigest, openWorktree, repoInfoOf = repoInfo, open = true }) {
  const held = item.item_status === 'claimed';
  const occupied = new Set(store.listItems(board).filter(entry => entry.item_status === 'claimed'
    && entry.item_parent_id === null).map(entry => entry.item_owner));
  /** A new claim never borrows an occupied or dirty checkout, even from this same session. */
  function freeCheckout(agent) {
    if (held) return agent.agent_id === item.item_owner;
    if (occupied.has(agent.agent_id)) return false;
    try { return sameCommonDir(repoInfoOf(agent.agent_path).commonDir, ctx.info.commonDir)
      && isClean(agent.agent_path) && untracked(agent.agent_path).length === 0; }
    catch { return false; }
  }
  const available = seats.filter((agent) => agent.agent_lane === item.item_lane
    && store.ROUTES.indexOf(agent.agent_route) >= store.ROUTES.indexOf(item.item_route) && freeCheckout(agent));
  // B5: the invoking seat takes several claims, each in its own item folder, so its live claims never send it to a new seat.
  const own = store.agentById(board, me.id);
  const ownFits = own && own.agent_lane === item.item_lane && store.ROUTES.indexOf(own.agent_route) >= store.ROUTES.indexOf(item.item_route)
    && (held ? item.item_owner === own.agent_id : true) && sameCommonDir(repoInfoOf(own.agent_path).commonDir, ctx.info.commonDir);
  let agent = ownFits ? own : held ? available.find((seat) => seat.agent_id === item.item_owner) : available[0];
  let created = false;
  if (!agent && !open) return { context: null, seat: null };
  if (!agent) {
    let opened;
    await openWorktree({ ...ctx.io, say: () => {}, result: (value) => { opened = value; } }, item.item_lane, me.route, me.family, me.model, false);
    agent = store.agentAt(board, opened.path);
    created = true;
  }
  const target = agent.agent_path === ctx.info.root ? ctx : contextAt({ ...ctx.io, cwd: agent.agent_path });
  if (!sameCommonDir(target.info.commonDir, ctx.info.commonDir)) throw new Refused('NOT_YOUR_CHECKOUT', 'the selected lane seat no longer belongs to this board; run pullboard next again');
  await bindLocalSession(target.info, { agent: agent.agent_id, digest: sessionDigest() });
  return { context: target, seat: { agent: agent.agent_id, lane: agent.agent_lane, path: target.info.root, created } };
}

/** A real runtime session may route across its own local seats; marker-only shells stay isolated. The CLI supplies its readers. */
export function nextSessionSeats(ctx, board, { listAgents, sessionDigest }) {
  if (ctx.info.isMain || ctx.io.personChannel === 'view' || ctx.io.personRequest
    || !AGENT_SESSION_IDS.some((name) => Boolean(process.env[name]))) return null;
  const digest = sessionDigest();
  return digest ? localSessionSeats(ctx.info, { agents: listAgents(board), digest }) : null;
}
