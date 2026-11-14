/** The pullboard relay command, in its own module so an item adding another command never edits these lines. */
import { nativeBoardOpeners } from '../context.js';
import { nativePersonRequestPorts } from '../context.js';
import * as store from '../../../../../packages/store/index.js';
import { gitSyncLinked } from '../../../../../packages/store/index.js';
import {
  requirePersonChannel,
} from '../../../../../packages/person/index.js';
import {
  listApiProjects,
} from '../../../../../packages/seats/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import { detailLines } from '../../../../../packages/link/index.js';
import { describeMove } from '../../../../../packages/outbox/index.js';
import { refusalLine } from '../../../../../packages/outbox/index.js';
import { DEFAULT_RELAY } from '../../../../../packages/link/index.js';
import { originRepository } from '../../../../../packages/link/index.js';
import { relayPersonCoordinator } from '../../../../../packages/link/index.js';
import { updateRelayMachine } from '../../../../../packages/link/index.js';
import { prepareBoardMembers } from '../../../../../packages/link/index.js';
import { githubKeys } from '../../../../../packages/link/index.js';
import {
  relayJoin,
  relayPair,
} from '../../../../../packages/keys/index.js';
import {
  executePersonRequests,
} from '../../../../../packages/link/index.js';
import {
  relayRoster,
  rosterLines,
} from '../../../../../packages/link/index.js';
import {
  relayOnAllCommand,
  revokeRelayDevice,
} from '../../../../../packages/link/index.js';
import {
  relayOff,
  relayOn,
  relayMachineContext,
  relayRecover,
  relayRecoverParked,
  relayRevoke,
  relayStatus,
  relayTokens,
  syncRelay,
} from '../../../../../packages/link/index.js';
import { outdatedSenderLine } from '../../../../../packages/link/index.js';
import { replaceOutdatedSender } from '../../../../../packages/link/index.js';
import {
  basename,
} from 'node:path';
import {
  agentDisplayName,
  context,
  main,
  ordered,
  withBoard,
  whoAmI,
} from '../entry.js';

/** Refusals that leave nothing more to recover once an outdated sender was replaced: nothing is parked here. */
const SENDER_ONLY_RECOVERY = new Set(['B26_PERSON_CHANNEL', 'RELAY_LINKED', 'RELAY_NOTHING_PARKED', 'RELAY_OUTBOX_WAITING']);

/** Run `pullboard relay` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  if (first === 'canary') return (await import('../../../../../packages/link/index.js')).run(io, { first: second, second: rest[0], rest: rest.slice(1), values }, { context, ordered, withBoard, whoAmI });
  if (['on', 'join'].includes(first) && gitSyncLinked(io.cwd)) throw new Refused('GIT_SYNC_LINKED', 'this board already shares moves through Git; it cannot start a second move order', 'keep sharing this board through origin');
  if (values['new-browser'] && first !== 'pair') throw new Refused('USAGE', 'pullboard relay pair --new-browser');
  if (first === 'members') {
    if (!['set', 'clear'].includes(second) || (second === 'set' ? !rest.length : rest.length) || values.url || values.all || values.skip) throw new Refused('USAGE', 'pullboard relay members set <login> [<login> ...], or pullboard relay members clear');
    requirePersonChannel(io.personChannel);
    const ctx = context(io);
    const state = relayMachineContext(ctx.info.root);
    if (!state || state.environment) throw new Refused('RELAY_NOT_LINKED', 'link this person’s computer before publishing board members');
    await withBoard(ctx, async board => {
      const revision = (store.readBoardMembers(board)?.body.revision ?? 0) + 1;
      const document = await prepareBoardMembers(ctx.info.root, state, second === 'clear' ? [] : rest, { githubKeys, revision });
      await ordered(ctx, board, 'setBoardMembers', [{ agentId: whoAmI(ctx, board).id, document }]);
      io.result?.({ board: state.board, revision, members: document.body.members });
      io.say(`Board member list revision ${revision}: ${document.body.members.length ? document.body.members.join(', ') : 'no additional members'}.`);
    });
    return 0;
  }
  if (first === 'recover') {
    if (second || rest.length || values.url || values.all) throw new Refused('USAGE', 'pullboard relay recover, or pullboard relay recover --skip <exact blocked next sequence>');
    if (!values.skip) {
      // One command, no choices: it resolves every move the relay refused for good, in place, under the same board id (#6693).
      // A sender an older pullboard started refuses every new move; replacing it is the recovery, and it needs no
      // person: it only restarts this machine's own sender (#7938).
      const stopped = replaceOutdatedSender(context(io).info.root, io.launchRelaySender);
      if (stopped) io.say(`relay recovery replaced the old relay sender: ${outdatedSenderLine(stopped)}; this version's sender now sends the waiting moves`);
      let resolved;
      try {
        requirePersonChannel('terminal', process.env, { command: 'pullboard relay recover' });
        resolved = await relayRecoverParked(context(io).info.root, io);
      } catch (error) {
        if (!stopped || !(error instanceof Refused) || !SENDER_ONLY_RECOVERY.has(error.code)) throw error;
        io.result?.({ stoppedSender: stopped.pid, engine: stopped.engine, current: stopped.current });
        return 0;
      }
      io.result?.(resolved);
      io.say(`relay recovery published a checkpoint at sequence ${resolved.sequence} under board ${resolved.board}; ${resolved.recovered.length} parked ${resolved.recovered.length === 1 ? 'move is' : 'moves are'} resolved, with no rejoin and no lost history`);
      return 0;
    }
    requirePersonChannel('terminal');
    const result = await relayRecover(context(io).info.root, Number(values.skip), io);
    io.result?.(result);
    io.say(result.adopted
      ? `relay recovery adopted the authenticated checkpoint at sequence ${result.sequence}; blocked sequence ${result.skipped} remains recorded as refused`
      : `relay recovery published at sequence ${result.sequence}; skipped blocked sequence ${result.skipped}`);
    return 0;
  }
  if (values.skip) throw new Refused('USAGE', '--skip is only valid with pullboard relay recover');
  if (first === 'devices') {
    if (second || rest.length || values.url || values.all) throw new Refused('USAGE', 'pullboard relay devices [--verbose]');
    const roster = await relayRoster({ verbose: values.verbose });
    io.result?.(roster);
    for (const line of rosterLines(roster, { verbose: values.verbose })) io.say(line);
    return 0;
  }
  if (first === 'revoke' && /^device-[0-9a-f]{32}$/u.test(second ?? '')) {
    if (rest.length || values.url || values.all) throw new Refused('USAGE', 'pullboard relay revoke <device>');
    const result = await revokeRelayDevice(second, io);
    io.result?.(result); io.say(result.notice); return 0;
  }
  if (values.all) {
    if (first !== 'on' || second || rest.length) throw new Refused('USAGE', 'pullboard relay on --all [--url <address>]');
    return await relayOnAllCommand(values.url, io, { name: values.name });
  }
  if (['tokens', 'revoke'].includes(first)) {
    if (rest.length || values.url || (first === 'tokens' && second) || (first === 'revoke' && !second)) {
      throw new Refused('USAGE', 'pullboard relay tokens, or pullboard relay revoke <token-id>');
    }
    const ctx = context(io);
    const result = first === 'tokens' ? await relayTokens(ctx.info.root, io) : await relayRevoke(ctx.info.root, second, io);
    io.result?.(result);
    if (first === 'tokens') {
      if (!result.tokens.length) io.say('no agent tokens on this board');
      const ctx = context(io);
      const agents = withBoard(ctx, (board) => store.listAgents(board));
      for (const row of result.tokens) io.say(row.id + '  ' + agentDisplayName(agents, ctx.config, row.agent) + '  ' + (row.revoked ? 'revoked' : 'expires ' + new Date(row.expires).toISOString()));
      // The person-made coordinator credential events: who set it up, what it revoked, what it issued.
      for (const row of result.coordinatorEvents ?? []) io.say(`coordinator ${row.reason} by person session ${row.session} at ${new Date(row.at).toISOString()}: issued ${row.issued}, revoked ${row.revoked.length ? row.revoked.join(', ') : 'none'}`);
    } else io.say('revoked token ' + result.id + '; other agent tokens are unchanged');
    return 0;
  }
  if (first === 'pair') {
    if (second || rest.length || values.url) throw new Refused('USAGE', 'pullboard relay pair');
    const ctx = context(io);
    if (values['new-browser']) return await relayOnAllCommand(undefined, io, { pairAdditional: true });
    return await relayPair(ctx.info.root, io, { DEFAULT_RELAY, originRepository, syncRelay, openBoard: nativeBoardOpeners(io).openBoard });
  }
  if (first === 'join') {
    if (!second || rest.length) throw new Refused('USAGE', 'pullboard relay join <code> [--url <address>]');
    const ctx = context(io);
    return await relayJoin(ctx.info.root, second, values.url, io, { name: values.name },
      { DEFAULT_RELAY, originRepository, relayPersonCoordinator, syncRelay, updateRelayMachine, openBoard: nativeBoardOpeners(io).openBoard });
  }
  if (second || rest.length || (first && !['on', 'off', 'status'].includes(first)) || (values.url && first !== 'on')) throw new Refused('USAGE', 'pullboard relay [status|on|off] [--url <address>]');
  const ctx = context(io);
  // pullboard relay status is the named form of plain pullboard relay: the same sync and report.
  if (!first || first === 'status') await relayRead(ctx.info.root, io);
  const result = first === 'on' ? await relayOn(ctx.info.root, values.url, io, { name: values.name })
    : first === 'off' ? await relayOff(ctx.info.root, io) : relayStatus(ctx.info.root, io);
  io.result?.(result);
  const boardName = listApiProjects().find((project) => project.root === ctx.info.root)?.name ?? basename(ctx.info.root);
  for (const line of detailLines(result, boardName, { describeMove, refusalLine })) io.say(line);
  return 0;
}

/**
 * Sync and run the phone's requests before a relay status read. A clone linked to another board than the
 * environment's token stays as it is and the read goes on with the notice, as every other read does [E18].
 *
 * @param {string} root
 * @param {any} io
 * @returns {Promise<void>}
 */
async function relayRead(root, io) {
  try { await syncRelay(root, io); }
  catch (error) {
    if (!(error instanceof Refused) || error.code !== 'RELAY_LINKED') throw error;
    io.err(`pullboard: [RELAY_LINKED] ${error.message}`);
    return;
  }
  await executePersonRequests(root, io, io.runCommand, nativePersonRequestPorts(io));
}
