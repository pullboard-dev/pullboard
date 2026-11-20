/** The pullboard answer command, in its own module so an item adding another command never edits these lines. */
import { basename } from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import {
  projectSiblings,
  resolveRepo,
} from '../../../../../packages/spec/index.js';
import {
  parseImplies,
} from '../../../../../packages/state/index.js';
import {
  laneNames,
  listApiProjects,
} from '../../../../../packages/seats/index.js';
import {
  requirePersonChannel,
} from '../../../../../packages/person/index.js';
import {
  requireSignedPerson,
} from '../../../../../packages/person/index.js';
import {
  actOn,
  context,
  agentDisplayName,
  idArg,
  ordered,
  personMode,
} from '../entry.js';

/** Run `pullboard answer` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  const reference = /^(.+)#([1-9]\d*)$/u.exec(first ?? '');
  if (reference) {
    // repo#id names a decision on another repo of this project; the answer runs on that repo's own board [N34].
    const ctx = context(io);
    const self = { root: ctx.info.root, name: ctx.config.name ?? basename(ctx.info.root) };
    const target = resolveRepo(reference[1], self, projectSiblings(ctx.info.root, ctx.config, listApiProjects));
    if (target.root !== self.root) {
      const there = Object.create(io, { cwd: { value: target.root } });
      return run(there, { first: reference[2], second, rest, values });
    }
    return run(io, { first: reference[2], second, rest, values });
  }
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  const asPerson = personMode(ctx, me, values);
  // With signed person moves on, the answer goes to the person's passkey as this exact request [E22].
  if (asPerson) { const confirmed = await requireSignedPerson(ctx, board, me, { verb: 'answer', item: idArg(first), args: { as: 'person', text: [second, ...rest].filter(Boolean).join(' '),
    ...(values.implies === undefined ? {} : { implies: String(values.implies) }), ...(values.supersedes === undefined ? {} : { supersedes: String(values.supersedes) }), ...(values.cause === undefined ? {} : { cause: String(values.cause) }) } });
  if (confirmed !== null) return confirmed; }
  if (asPerson) requirePersonChannel(ctx.io.personChannel);
  const implies = parseImplies(values.implies);
  const supersedes = values.supersedes === undefined ? undefined : idArg(String(values.supersedes).replace(/^#/u, ''));
  const id = await ordered(ctx, board, 'answerDecision', [idArg(first), { agentId: me.id, text: [second, ...rest].filter(Boolean).join(' '), lanes: laneNames(ctx.config), asPerson, channel: ctx.io.personChannel ?? 'terminal',
    ...(implies ? { implies } : {}), ...(supersedes ? { supersedes } : {}),
    ...(values.origin === undefined ? {} : { origin: values.origin }), ...(values.rationale === undefined ? {} : { rationale: values.rationale }),
    ...(values.cause === undefined ? {} : { cause: String(values.cause) }) }]);
  const ask = store.getShout(board, idArg(first));
  io.result?.({ id, answers: ask.shout_id });
  if (asPerson) {
    const originalAsker = ask.shout_answers === null ? ask.shout_from : store.getShout(board, ask.shout_answers).shout_from;
    io.say(`person answered #${ask.shout_id}; notified ${agentDisplayName(store.listAgents(board), ctx.config, originalAsker)} as #${id}`);
  } else {
    io.say(`answered #${ask.shout_id} to ${agentDisplayName(store.listAgents(board), ctx.config, ask.shout_from)} as #${id}`);
  }
  return 0;
});
}
