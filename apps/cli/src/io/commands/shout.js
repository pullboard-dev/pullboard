import { rulingOwner } from '../../../../../packages/spec/index.js';
import { rulingRowReader } from '../../../../../packages/spec/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { addressedSeat } from '../../../../../packages/seats/index.js';
import { wakeRoutedSeat } from '../../../../../packages/seats/index.js';
/** The pullboard shout command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import { requireReadableShout } from '../../../../../packages/shouts/index.js';
import { requireCoordinatorShoutPurpose } from '../../logic/purpose.js';
import { refuseRestatedReport } from '../../logic/purpose.js';
import { handoffMoveProblem } from '../../../../../packages/state/index.js';
import {
  COORDINATOR,
} from '../../../../../packages/config/index.js';
import {
  laneNames,
} from '../../../../../packages/seats/index.js';
import {
  personShout,
} from '../../../../../packages/person/index.js';
import {
  actOn,
  agentDisplayName,
  evidenceFrom,
  ordered,
} from '../entry.js';

/** Run `pullboard shout` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  let options;
  if (values.options !== undefined) {
    try { options = JSON.parse(values.options); }
    catch { throw new Refused('BAD_DECISION_OPTIONS', 'give --options as a JSON array of distinct choices'); }
  }
  let effects, ruling;
  if (values.effects !== undefined) {
    try { effects = JSON.parse(values.effects); }
    catch { throw new Refused('RULING_EFFECTS', 'give --effects as a JSON array of concrete effects'); }
    if (!values.decision) throw new Refused('RULING_EFFECTS', 'use --decision with --effects');
    ruling = rulingOwner(effects, { readRow: rulingRowReader(ctx.info.root, ctx.config) });
    effects = ruling.effects.map(entry => entry.effect);
  }
  const recipient = addressedSeat(first, store.boardId(board));
  const addressed = typeof first === 'string' && first.startsWith('pullboard:');
  if (addressed && values.item !== undefined) throw new Refused('USAGE', 'use either a seat address or --item, not both');
  const evidence = values.evidence === undefined ? null : evidenceFrom(ctx, values);
  const seatIds = board.db.prepare('SELECT agent_id FROM agent').all().map((agent) => agent.agent_id);
  if (addressed && recipient !== COORDINATOR && !seatIds.includes(recipient)) throw new Refused('NO_READER', 'copy the address of a joined seat from pullboard agents');
  const recipients = ['all', 'person', ...laneNames(ctx.config), ...seatIds];
  const hasRecipient = first && (addressed || recipients.includes(first)) && (values.item === undefined || second !== undefined);
  const to = values.item !== undefined ? `item:${values.item}` : hasRecipient ? recipient : values.decision ? (me.id === COORDINATOR ? 'person' : COORDINATOR) : first ?? '';
  const text = [hasRecipient ? second : first, ...(hasRecipient ? rest : [second, ...rest])].filter(Boolean).join(' ');
  if (!text.trim()) throw new Refused('EMPTY_SHOUT', 'a shout needs text');
  requireReadableShout(text);
  // A replaced seat is refused before the shout-kind rule: AGENT_REPLACED is the answer, not COORDINATOR_STATUS_FACT (#1764).
  const retired = handoffMoveProblem(board, personShout(io, me) ? store.PERSON : me.id, 'shout', [{ item: values.item === undefined ? undefined : Number(values.item) }]);
  if (retired) throw retired;
  requireCoordinatorShoutPurpose({ from: personShout(io, me) ? store.PERSON : me.id, to, kind: values.kind });
  refuseRestatedReport(board, { from: personShout(io, me) ? store.PERSON : me.id, to, kind: values.kind, text, item: values.item, decision: values.decision, evidence });
  const id = await ordered(ctx, board, 'shout', [{ from: personShout(io, me) ? store.PERSON : me.id, to, text, ...(values.item !== undefined ? { item: Number(values.item) } : {}), lanes: laneNames(ctx.config), decision: Boolean(values.decision), ...(options !== undefined ? { options } : {}), ...(effects === undefined ? {} : { effects }), ...(values.kind === undefined ? {} : { kind: values.kind }), ...(values.clause === undefined ? {} : { clause: values.clause }), ...(values.news ? { news: true } : {}), evidence }]);
  io.result?.({ id, decision: Boolean(values.decision), ...(ruling ? { ruling } : {}) });
  if (ruling) io.say(`computed call: ${ruling.owner}; execution guards still apply`);
  const agents = store.listAgents(board);
  const routed = me.id === COORDINATOR ? /\b(?:review|verify|build|take|claim|fix|resubmit|land|work on|act on)\b[^#\n]{0,60}#(\d+)/iu.exec(text) : null;
  if (routed) {
    const target = store.getShout(board, id).shout_to;
    const wake = await wakeRoutedSeat(ctx.info, { boardId: store.boardId(board), seat: agents.find(agent => agent.agent_id === target), item: Number(routed[1]) });
    if (wake.error) io.err?.(`seat wake unavailable: ${wake.error}`);
  }
  const recipientName = agents.some((agent) => agent.agent_id === to) ? agentDisplayName(agents, ctx.config, to) : to;
  io.say(values.decision ? `asked ${recipientName} for a decision as #${id}; it stays open until someone runs: pullboard answer ${id} "<the decision>"` : `shouted to ${recipientName}`);
  return 0;
});
}
