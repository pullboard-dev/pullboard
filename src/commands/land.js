import { codeIsFromMain } from '../git.js';
import { syncRelay } from '../relay.js';
/** The pullboard land command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board.js';
import {
  COORDINATOR,
} from '../config.js';
import {
  gateWaitReporter,
} from '../gate-wait.js';
import {
  land,
} from '../land.js';
import {
  agentSessionDigest,
  requirePersonChannel,
} from '../person.js';
import {
  requireSignedPerson,
} from '../person-signing-cli.js';
import {
  Refused,
} from '../refused.js';
import {
  staleVerdictRefusal,
} from '../verdict-freshness.js';
import {
  randomUUID,
} from 'node:crypto';
import {
  actOn,
  ordered,
} from '../cli.js';

/** Run `pullboard land` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  if (me.id !== COORDINATOR || !ctx.info.isMain) throw new Refused('COORDINATOR_ONLY', 'only the coordinator lands verified batches; ask your coordinator to run pullboard land');
  if (first || second || rest.length) throw new Refused('USAGE', 'pullboard land [--max N] [--dry-run] [--adopt] | --waive <test> --until <date> --reason "why"');
  if (values.waive !== undefined) {
    const confirmed = await requireSignedPerson(ctx, board, me, { verb: 'land-waive', args: { waive: String(values.waive), until: String(values.until ?? ''), reason: String(values.reason ?? '') } });
    if (confirmed !== null) return confirmed;
    requirePersonChannel(io.personChannel);
    const waiver = await ordered(ctx, board, 'recordLandingWaiver', [{ agentId: store.PERSON, channel: io.personChannel ?? 'terminal',
      id: randomUUID(), test: values.waive, until: values.until, reason: values.reason }]);
    io.result?.({ batch: null, landed: [], conflicts: [], blocked: [], culprits: [], flakes: [], waiver });
    io.say(`waived ${waiver.kind ?? store.landingWaiverKind(waiver.test)} ${waiver.test} until ${waiver.until}: ${waiver.reason}`);
    return 0;
  }
  if (values.until !== undefined || values.reason !== undefined || values.max !== undefined && (!/^[1-9][0-9]*$/u.test(values.max) || !Number.isSafeInteger(Number(values.max)))) throw new Refused('USAGE', 'use --max with a positive item count, or --waive with --until and --reason');
  if (!values['dry-run'] && codeIsFromMain()) {
    const afterEventId = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n;
    await (await import('../main-audit-state.js')).activateMainAudits(ctx.info.root, afterEventId, store.boardId(board));
  }
  const result = await land({ root: ctx.info.root, board,
    write: (operation, parameters) => ordered(ctx, board, operation, parameters), refresh: () => syncRelay(ctx.info.root, io), say: io.say, owner: agentSessionDigest() ?? `pid-${process.pid}`,
    maximum: values.max === undefined ? Infinity : Number(values.max), dryRun: Boolean(values['dry-run']), adopt: Boolean(values.adopt), onWait: gateWaitReporter(io) });
  io.result?.(result);
  for (const blocked of result.blocked ?? []) if (blocked.code === 'STALE_VERDICT') io.say(staleVerdictRefusal({ item_id: blocked.id }, blocked).message);
  if (!result.batch && !result.deferredUntil) io.say(result.items ? `would land: ${result.items.map((id) => `#${id}`).join(', ') || 'none'}` : 'no verified items ready to land');
  return 0;
});
}
