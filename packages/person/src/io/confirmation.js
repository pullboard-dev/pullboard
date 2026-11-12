import { getItem } from "../../../store/index.js";
/** Wait for one passkey-confirmed terminal request to finish through the ordinary native executor [E22,H16]. */
import { setTimeout as delay } from 'node:timers/promises';
import { personRequestRecords } from "../logic/request.js";
import { Refused } from "../../../kernel/index.js";
import { loadMachineSettings } from "../../../config/index.js";

/** Preserve the ordinary command's required JSON fields while adding its confirmed request receipt. */
function confirmedResult(record, board) {
  switch (record.move.verb) {
    case 'add':
    case 'edit': return { item: getItem(board, record.move.verb === 'add' ? record.result : record.move.item) };
    case 'bar-sign': return { signed: record.result };
    case 'answer': return { id: record.result, answers: record.move.item };
    case 'spec-approve':
    case 'spec-decline':
    case 'spec-answer': return { decisions: record.result };
    case 'fact': return { item: record.move.item, fact: record.result };
    case 'hold': return { lane: record.move.args.lane, held: !record.move.args.off, reason: record.move.args.off ? null : record.move.args.reason };
    case 'sentinel-approve':
    case 'sentinel-decline': return { sentinel: record.result };
    case 'land-waive': return { batch: null, landed: [], conflicts: [], blocked: [], culprits: [], flakes: [], waiver: record.result };
    case 'signing': return { settings: loadMachineSettings(), person: { signed: record.result.signed } };
    default: throw new Refused('PERSON_PROPOSAL', 'this terminal cannot render the confirmed request result', 'read its original receipt in the relay view before retrying');
  }
}

/**
 * Keep the initiating terminal alive until its exact signed request executes or refuses.
 * Native executor elects/records the existing executor and checks the signed intent; this creates no authority.
 * The caller returns immediately after this resolves: it must never run the original unsigned action again.
 * waitMs bounds polling, not a transport already in flight; existing transport deadlines remain authoritative.
 * The CLI supplies relay sync, request execution and its command entry point through the options object.
 */
export async function awaitPersonConfirmation(ctx, board, request, where, { waitMs = 120_000, syncRelay, executePersonRequests, main } = {}) {
  if (typeof syncRelay !== 'function' || typeof executePersonRequests !== 'function' || typeof main !== 'function') {
    throw new Refused('PERSON_CONFIRMATION_PORT', 'the CLI caller must provide relay sync and native request execution');
  }
  const waiting = `pullboard: confirm request ${request.id} with your passkey at ${where}; this terminal is waiting`;
  // A waiting terminal says where to confirm while it waits, even when its result is one JSON document at the end.
  if (typeof ctx.io.stderr?.write === 'function') ctx.io.stderr.write(`${waiting}\n`); else ctx.io.err(waiting);
  const until = Date.now() + waitMs;
  for (;;) {
    await syncRelay(ctx.info.root, ctx.io);
    await executePersonRequests(ctx.info.root, ctx.io, main);
    const record = personRequestRecords(board).find(entry => entry.id === request.id && !entry.duplicateOf);
    if (record?.status === 'refused') {
      throw new Refused(record.error.code, record.error.message, record.error.next);
    }
    // Repo-changing spec decisions finish the native CLI stage by creating a coordinator request.
    // This reports that stage, never promises its eventual merge/landing outcome.
    if (record?.status === 'done' || record?.coordinatorRequest && Object.hasOwn(record, 'result')) {
      const result = { ...confirmedResult(record, board), request: request.id, status: record.status,
        ...(record.coordinatorRequest ? { coordinatorRequest: record.coordinatorRequest } : {}) };
      ctx.io.personConfirmation = { request: result.request, status: result.status };
      ctx.io.result?.(result);
      ctx.io.say(`passkey-confirmed request ${request.id} ${record.coordinatorRequest ? 'sent to the coordinator' : 'completed'}`);
      return 0;
    }
    if (Date.now() >= until) {
      throw new Refused('PERSON_SIGNED', `request ${request.id} is still waiting for passkey confirmation`,
        `confirm the existing request at ${where}; inspect its receipt before sending the action again`);
    }
    await delay(Math.min(250, Math.max(1, until - Date.now())));
  }
}
