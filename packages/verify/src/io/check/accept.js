import { CHECK_ACCEPT_ENGINE } from '../../../../state/light.js';
export { CHECK_ACCEPT_ENGINE } from '../../../../state/light.js';
/**
 * A check that already passes on main proves nothing, so a board that asks for it holds the item
 * until the person accepts that exact check [V2,V4,B26].
 */
import { createHash } from 'node:crypto';
import { COORDINATOR } from '../../../../config/index.js';
import { Refused } from '../../../../kernel/index.js';


/** The setting value that turns today's warning into a hold. */
export const PROVES_NOTHING_HOLD = 'hold';

/**
 * A check that would prove the work (#917): one that runs the item's new test file. The file is the one the
 * criterion or brief names, or one named after the item; the runner is the item's own Node test runner when it uses
 * one, and node --test otherwise, so an agent that set `npm test` gets a command it can paste.
 *
 * @param {{ item_title?: string, item_check?: string|null, item_criterion?: string|null, item_brief?: string|null }} item
 * @returns {string}
 */
export function provingCheck(item) {
  const named = /\b((?:test|packages\/[\w-]+\/tests|apps\/[\w-]+\/(?:tests|journeys))\/[\w./-]+\.test\.[cm]?js)\b/u.exec(`${item.item_criterion ?? ''}\n${item.item_brief ?? ''}`)?.[1];
  const slug = String(item.item_title ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48) || 'the-work';
  const runner = /^node\s+(?:bin\/run-tests|packages\/gate\/src\/io\/run\/tests)\.js\b/u.test(item.item_check ?? '') ? 'node apps/cli/src/io/run/tests.js' : 'node --test';
  return `${runner} ${named ?? `test/${slug}.test.js`}`;
}

/**
 * Digest one check's exact text. An acceptance names this digest, so it binds to the words the
 * person read and cannot carry over to a different check.
 *
 * @param {string} command
 * @returns {string}
 */
export function checkDigest(command) {
  return createHash('sha256').update(String(command)).digest('hex');
}

/**
 * Record the person's acceptance of an item's current check, as an ordered board move.
 * Only the person, from the terminal or the view, may make it; the digest must match the check
 * the item carries now, so an acceptance prepared for one check cannot land on another.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, channel: string, digest: string }} who
 * @returns {{ id: number, digest: string, check: string }}
 */
export function acceptCheck(board, id, { agentId, channel, digest }) {
  const { PERSON, atomic, logEvent } = board.nativePorts;
  const { itemById } = board.runtimePorts.verification;
  if (agentId !== PERSON) throw new Refused('CHECK_ACCEPT_PERSON_ONLY', 'only the person accepts a check that already passes on main; ask the coordinator to bring it to the person');
  if (!['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_CHANNEL', 'a check acceptance uses the person’s terminal or view; run pullboard view');
  return atomic(board, () => {
    const item = itemById(board, id);
    if (!item.item_check) throw new Refused('NO_CHECK', `#${id} has no check command to accept; its proof is the project gate`);
    if (typeof digest !== 'string' || digest !== checkDigest(item.item_check)) {
      throw new Refused('CHECK_ACCEPT_STALE', `#${id}'s check changed since this acceptance was prepared; read the current check with pullboard show ${id} and accept it again`);
    }
    logEvent(board, PERSON, 'check_accept', id, { digest, channel });
    return { id, digest, check: item.item_check };
  });
}

/**
 * The person's live acceptance of the item's current check, or null.
 * It counts only when its digest names the current check text and no later edit set a
 * different check, so changing the check (even back to an old one) needs a new acceptance.
 *
 * @param {any} board
 * @param {any} item
 * @returns {{ event: number, digest: string } | null}
 */
export function checkAcceptance(board, item) {
  if (!item?.item_check) return null;
  const { PERSON } = board.nativePorts;
  const digest = checkDigest(item.item_check);
  const rows = board.db.prepare("SELECT event_id, event_by, event_kind, event_detail FROM event WHERE item_id = ? AND event_kind IN ('check_accept', 'edit') ORDER BY event_id").all(item.item_id);
  let accepted = null;
  for (const row of rows) {
    const detail = JSON.parse(row.event_detail);
    if (row.event_kind === 'check_accept' && row.event_by === PERSON && detail.digest === digest) accepted = { event: row.event_id, digest };
    else if (row.event_kind === 'edit' && Object.hasOwn(detail, 'check') && detail.check !== item.item_check) accepted = null;
  }
  return accepted;
}

/**
 * Refuse a claim or submit whose check already passes on main, when the board's
 * checks.provesNothing setting is "hold" and the person has not accepted that check.
 * With no setting the green baseline stays a warning, as on boards made before the setting.
 *
 * @param {() => any} mainConfig - reads accepted main's config, so a worktree's uncommitted edit cannot
 *   lift the hold; called only for a green, unaccepted check, so other claims never read main for it
 * @param {any} board
 * @param {any} item - as getItem returns it, with item_check_baseline
 */
export function refuseProvesNothing(mainConfig, board, item) {
  const base = item?.item_check_baseline;
  if (base?.result !== 'green' || base.command !== item.item_check || checkAcceptance(board, item)) return;
  if (mainConfig()?.checks?.provesNothing !== PROVES_NOTHING_HOLD) return;
  throw new Refused('CRITERION_PROVES_NOTHING',
    `#${item.item_id} is held: its check already passes on main ${String(base.main).slice(0, 12)}, so it proves nothing: ${base.command}`,
    `ask the coordinator for a check that fails before the work, ready to paste: pullboard shout coordinator --kind question --decision "#${item.item_id} is held because its check passes on main; please set: pullboard edit ${item.item_id} --check '${provingCheck(item)}'"; or the person accepts this one: pullboard check accept ${item.item_id}`);
}

/**
 * Refuse any claim of an open or claimed item whose check is held, reading accepted main's setting.
 * Claim, next, next --build and pullboard run all order their claim through the CLI's one claim
 * helper, which calls this first, so no route records a claim on a held item.
 *
 * @param {string} root
 * @param {any} board
 * @param {number} id
 */
export function refuseClaimProvesNothing(root, board, id, { mainPolicy }) {
  const { getItem } = board.nativePorts;
  const item = getItem(board, id);
  if (['open', 'claimed'].includes(item.item_status)) refuseProvesNothing(() => mainPolicy(root).config, board, item);
}

/**
 * Run pullboard check accept <id>: the person accepts an item's check as it reads now, which lifts a
 * hold on a check already green on main. A person-only move (P6): an agent shell, a remote shell, a
 * worktree, the API and MCP are refused, and the move carries the check's digest so a changed
 * check needs a new acceptance. The CLI passes its own context, board and ordered-move helpers.
 *
 * @param {any} io
 * @param {string | undefined} first - the item id
 * @param {string[]} rest
 * @param {{ context: Function, withBoard: Function, whoAmI: Function, ordered: Function, idArg: Function, requirePersonChannel: Function }} cli
 * @returns {Promise<number>}
 */
export async function checkAcceptCommand(io, first, rest, { context, withBoard, whoAmI, ordered, idArg, requirePersonChannel }) {
  requirePersonChannel(io.personChannel);
  if (!/^#?\d+$/u.test(first ?? '') || rest.length) throw new Refused('USAGE', 'pullboard check accept <id>');
  const ctx = context(io);
  return withBoard(ctx, async (board) => {
    const { getItem, PERSON } = board.nativePorts;
    if (!ctx.info.isMain || whoAmI(ctx, board).id !== COORDINATOR) throw new Refused('B26_PERSON_APPROVAL', 'only the person accepts a check, from the main checkout or the view', 'ask the person to accept it in pullboard view, or in their own terminal at the main checkout');
    const item = getItem(board, idArg(first));
    if (!item.item_check) throw new Refused('NO_CHECK', `#${item.item_id} has no check command to accept; its proof is the project gate: pullboard gate`);
    const accepted = await ordered(ctx, board, 'acceptCheck', [item.item_id, { agentId: PERSON, channel: io.personChannel ?? 'terminal', digest: checkDigest(item.item_check) }]);
    io.result?.({ id: accepted.id, digest: accepted.digest, check: accepted.check });
    io.say(`accepted #${accepted.id}'s check as it reads now: ${accepted.check}`);
    io.say('a changed check needs the person to accept it again');
    return 0;
  });
}
