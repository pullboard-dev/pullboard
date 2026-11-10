/** Typed coordinator-move requests never borrow the coordinator's authority [B3,N26]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { actOn } from '../entry.js';
import { context } from '../entry.js';
import { idArg } from '../entry.js';
import { ordered } from '../entry.js';
import { whoAmI } from '../entry.js';
import { withBoardRead } from '../entry.js';
import { typedRequests } from '../../../../../packages/store/index.js';

/** Reject unrelated global flags instead of silently interpreting a person or execution option. */
function flags(values, allowed) {
  const extra = Object.keys(values).filter(key => !['json', ...allowed].includes(key));
  if (extra.length) throw new Refused('USAGE', `unsupported request option --${extra[0]}; run pullboard request --help`);
}

/** Parse an ordered comma-separated batch, rejecting duplicates and unsafe or missing identities. */
function ids(text, label) {
  const values = String(text ?? '').split(',');
  if (!values.length || values.length > 100 || values.some(value => !/^#?[1-9]\d*$/u.test(value))) {
    throw new Refused('USAGE', `give ${label} as up to 100 comma-separated positive IDs`);
  }
  const result = values.map(value => Number(value.replace(/^#/u, '')));
  if (result.some(value => !Number.isSafeInteger(value)) || new Set(result).size !== result.length) {
    throw new Refused('USAGE', `give distinct safe positive ${label}`);
  }
  return result;
}

/** List this seat's requests or the coordinator's whole queue without acquiring a write session. */
function list(io, values) {
  flags(values, ['all']);
  const ctx = context(io);
  const requests = withBoardRead(ctx, board => {
    const me = whoAmI(ctx, board);
    return typedRequests(board, { all: Boolean(values.all), ...(me.id === 'coordinator' ? {} : { requester: me.id }) });
  });
  io.result?.({ requests });
  for (const request of requests) io.say(`#${request.id} ${request.verb} #${request.item}${request.route ? ` -> ${request.route}` : ''} [${request.cause}] ${request.requester}: ${request.status}`);
  if (!requests.length) io.say('no typed coordinator requests');
  return 0;
}

/** File, list or batch-answer typed requests; actual moves retain their original native command guards. */
export async function run(io, { first, second, rest, values }) {
  if (!first || first === 'list') {
    if (second || rest.length) throw new Refused('USAGE', 'pullboard request list [--all]');
    return list(io, values);
  }
  if (first === 'answer') {
    flags(values, ['note', 'acted-on']);
    const requestIds = ids(second, 'request IDs');
    if (rest.length !== 1 || !['done', 'declined'].includes(rest[0])) {
      throw new Refused('USAGE', 'pullboard request answer <ids> done|declined --note "why" [--acted-on <event-ids>]');
    }
    const outcome = rest[0];
    const eventIds = values['acted-on'] === undefined ? [] : ids(values['acted-on'], 'native event IDs');
    if (outcome === 'done' ? eventIds.length !== requestIds.length : eventIds.length > 0) {
      throw new Refused('USAGE', 'done needs one --acted-on native event ID per request, in the same order; declined takes none');
    }
    return actOn(io, async (ctx, board, me) => {
      const answers = await ordered(ctx, board, 'answerTypedRequests', [{ agentId: me.id,
        answers: requestIds.map((requestId, index) => ({ requestId, outcome,
          ...(values.note === undefined ? {} : { note: values.note }),
          ...(outcome === 'done' ? { eventId: eventIds[index] } : {}) })) }]);
      io.result?.({ requests: answers });
      io.say(`answered ${requestIds.length} typed request${requestIds.length === 1 ? '' : 's'} as ${outcome}`);
      return 0;
    });
  }
  flags(values, ['cause', 'route', 'note']);
  if (rest.length) throw new Refused('USAGE', 'pullboard request reopen|hold|withdraw|reroute <id> --cause <key> [--route <tier>] [--note "why"]');
  const itemId = idArg(second);
  return actOn(io, async (ctx, board, me) => {
    const id = await ordered(ctx, board, 'fileTypedRequest', [{ agentId: me.id, verb: first, itemId,
      cause: values.cause, ...(values.route === undefined ? {} : { route: values.route }),
      ...(values.note === undefined ? {} : { note: values.note }) }]);
    io.result?.({ id, requests: typedRequests(board, { all: true, itemId }).filter(request => request.id === id) });
    io.say(`queued request #${id}: ${first} #${itemId}; coordinator answers with pullboard request answer`);
    return 0;
  });
}
