/** The blueprint fit verbs: blueprint fit, spec fit, spec fit edit and spec fit approve [S1,E3]. */
import { loadDoctrine } from '../../../../doctrine/light.js';
import { fileSystemAdapter } from '../../../../fs/index.js';
import * as store from '../../../../store/index.js';
import {
  approveFit,
  editFit,
  fitLine,
  fitSummary,
  proposeFit,
  readFitBatch,
  refuseOwnFit,
} from '../fit.js';
import { readBlueprint } from '../main.js';
import { COORDINATOR } from '../../../../config/index.js';
import { headCommit } from '../../../../git/index.js';
import {
  agentSessionDigest,
  requirePersonChannel,
} from '../../../../person/index.js';
import { Refused } from '../../../../kernel/index.js';
import { prepareRowDecisions } from '../../../../spec/index.js';
import { loadSpec } from '../../../../spec/index.js';

const fs = fileSystemAdapter();

/**
 * Blueprint fit (#730): a seat proposes how a blueprint's target fits this repo; the person lists,
 * edits and approves the waiting batch. The proposer is this seat's own id and agent session, never
 * a flag. Edit and approve first refuse the session that proposed, then any non-person channel.
 * The CLI passes its ordered dispatch and its identity lookup, so every board move goes through the
 * same engine path as any other command.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string } | null} me - The seat, for a proposal; null for the person's verbs.
 * @param {'list' | 'propose' | 'edit' | 'approve' | string} verb
 * @param {string[]} args
 * @param {Record<string, any>} values
 * @param {{ ordered: Function, whoAmI: Function }} cli
 * @returns {Promise<number>}
 */
export async function fitCommand(ctx, board, me, verb, args, values, { ordered, whoAmI }) {
  const { io } = ctx;
  const [spec, items, at] = [loadSpec(ctx.info.root, ctx.config), store.listItems(board, { all: true }), new Date().toISOString()];
  const usage = 'pullboard spec fit [approve <batch>] | spec fit edit <row id or #item> keep|adapt|drop|answer [--text "..."] [--reason "why"]';
  /** List the batch and its code; the person's own listing is their reading of it. */
  const show = (extra = {}) => {
    const read = readFitBatch(ctx.info.commonDir, { isMain: ctx.info.isMain, channel: io.personChannel });
    io.result?.({ ...extra, proposals: read.proposals, batch: read.batch });
    (read.proposals.length ? fitSummary(read) : ['no blueprint fit proposals wait for the person']).forEach((line) => io.say(line));
    return 0;
  };
  if (verb === 'list') return show();
  if (verb === 'propose') {
    const [reference, target, decision, ...extra] = args;
    if (!reference || !target || !decision || extra.length) throw new Refused('USAGE', 'pullboard blueprint fit <name or file> <row id or #item> keep|adapt|drop|answer [--text "..."] [--reason "why"]');
    // Only the proposal's own words are flags; who proposed it is this seat, so no flag can name another.
    const flag = Object.keys(values).find((key) => !['text', 'reason', 'json'].includes(key));
    if (flag) throw new Refused('FLAG_NOT_ALLOWED', `blueprint fit does not take --${flag}; it records this seat as the proposer and takes only --text and --reason`);
    const proposal = proposeFit({ commonDir: ctx.info.commonDir, blueprint: readBlueprint(reference, io.cwd), specSource: fs.readFile(spec.file, 'utf8'),
      spec, items, by: me.id, session: agentSessionDigest(), at }, { target, decision, text: values.text, reason: values.reason });
    io.result?.({ proposals: [proposal] });
    io.say(`recorded ${fitLine(proposal)}\nnext: nothing applies until the person reads the batch with pullboard spec fit and approves it with pullboard spec fit approve <batch>`);
    return 0;
  }
  if (!['edit', 'approve'].includes(verb) || (verb === 'approve' && args.length !== 1) || (verb === 'edit' && args.length !== 2)) throw new Refused('USAGE', usage);
  refuseOwnFit(ctx.info.commonDir, agentSessionDigest());
  requirePersonChannel(io.personChannel);
  const person = whoAmI(ctx, board);
  if (!ctx.info.isMain || person.id !== COORDINATOR) throw new Refused('B26_PERSON_APPROVAL', 'only the person, from the main checkout, edits or approves blueprint fit proposals; use pullboard spec fit to read them');
  if (verb === 'edit') {
    const proposal = editFit(ctx.info.commonDir, { target: args[0], decision: args[1], text: values.text, reason: values.reason, at });
    io.say(`edited ${fitLine(proposal)}`);
    // The whole batch is shown again, so the person reads what they will approve.
    return show({ edited: proposal });
  }
  const commit = headCommit(ctx.info.root) ?? '';
  const done = await approveFit({ commonDir: ctx.info.commonDir, spec, items, session: agentSessionDigest(), at, code: args[0] }, {
    decide: async (rows) => await ordered(ctx, board, 'recordRowDecisions', [{ agentId: store.PERSON, channel: io.personChannel ?? 'terminal',
      decisions: rows.flatMap(({ proposal, note }) => prepareRowDecisions(ctx.info.root, ctx.config, { ids: [proposal.target], decision: proposal.decision === 'drop' ? 'decline' : 'approve',
        reason: proposal.reason, text: proposal.text ?? undefined, on: at, commit, note }, { loadDoctrine })) }]),
    fact: async (id, text) => await ordered(ctx, board, 'appendFact', [id, { agentId: person.id, kind: 'decision', text }]),
    criterion: async (id, text) => await ordered(ctx, board, 'editItem', [id, { agentId: person.id, criterion: text }]),
    withdraw: async (id, reason) => await ordered(ctx, board, 'withdraw', [id, { agentId: person.id, reason }]),
  });
  io.result?.(done); done.proposals.forEach((proposal) => io.say(`approved ${fitLine(proposal)}`));
  if (done.decisions.length) io.say('next: the coordinator runs pullboard spec apply to write the row decisions');
  return 0;
}
