/** The pullboard fact command, in its own module so an item adding another command never edits these lines. */
import {
  parseImplies,
} from '../../../../../packages/state/index.js';
import {
  requirePersonChannel,
} from '../../../../../packages/person/index.js';
import {
  requireSignedPerson,
} from '../../../../../packages/person/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import * as store from '../../../../../packages/store/index.js';
import {
  actOn,
  idArg,
  ordered,
  personMode,
} from '../entry.js';

/** The evidence kinds a clause tick declares, as the state cell's clauseTicks reads them (EVIDENCE_KINDS in packages/state/src/logic/clauses.js). */
const TICK_KINDS = ['test', 'command', 'screenshot', 'measurement', 'reasoning'].join('|');

/**
 * The refusal for a note that starts with a clause number and names an evidence kind but is not "clause N [kind]: evidence", or null.
 * Why: clauseTicks ignores such a note without a word (#10589 builders wrote "clause 1: [test] run <id> ..."), so accept refused
 * CLAUSE_UNTICKED three times; refusing it at write names the form, and a green test run ticks [test] clauses itself [C7].
 * @param {string} kind The fact kind.
 * @param {string} text The fact text.
 * @returns {Refused|null}
 */
export function tickFormatProblem(kind, text) {
  const note = String(text ?? '').trim();
  const names = new RegExp(`\\[(?:${TICK_KINDS})\\]`, 'iu');
  if (kind !== 'note' || !/^clause\s+\d+\b/iu.test(note) || !names.test(note)) return null;
  const form = new RegExp(`^clause \\d+ \\[(?:${TICK_KINDS})\\]:\\s*\\S`, 'u');
  if (form.test(note)) return null;
  return new Refused('TICK_FORMAT', 'a clause tick reads "clause N [kind]: evidence" (such as "clause 1 [test]: green run <id>, case <title>"); a green pullboard test run from the item folder ticks [test] clauses itself, so run it there instead of typing the note', 'pullboard test <the clause test file> from the item folder, or write the note as clause N [kind]: evidence');
}

/** Run `pullboard fact` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  if (!first || !second || rest.length !== 1) throw new Refused('USAGE', 'pullboard fact <id> <kind> <text> [--answers <bar-check-fact-id>] [--supersedes <fact-id>] [--ref path:lines@full-sha] [--implies <ids>] [--cause <key> --never-again --as person]');
  const id = idArg(first);
  const malformed = tickFormatProblem(second, rest[0]);
  if (malformed) throw malformed;
  const implies = parseImplies(values.implies);
  const asPerson = values.as === 'person' && personMode(ctx, me, values);
  if (second === 'urgent' && !asPerson) throw new Refused('B26_PERSON_APPROVAL', 'only the person marks urgency from the main checkout: pullboard fact <id> urgent on --as person');
  if (asPerson || values['never-again'] || values.cause !== undefined) {
    const confirmed = await requireSignedPerson(ctx, board, me, { verb: 'fact', item: id, args: { kind: second, text: rest[0], as: 'person',
      ...(values.supersedes === undefined ? {} : { supersedes: String(values.supersedes) }), ...(values.ref === undefined ? {} : { ref: String(values.ref) }),
      ...(values.implies === undefined ? {} : { implies: String(values.implies) }), ...(values.cause === undefined ? {} : { cause: String(values.cause) }),
      ...(values['never-again'] ? { 'never-again': true } : {}) } });
    if (confirmed !== null) return confirmed;
  }
  if (asPerson) requirePersonChannel(ctx.io.personChannel);
  const marked = asPerson || values['never-again'] || values.cause !== undefined
    ? { cause: values.cause ?? null, neverAgain: Boolean(values['never-again']), asPerson, channel: ctx.io.personChannel ?? 'terminal' } : {};
  const fact = await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: second,
    text: rest[0], supersedes: values.supersedes ?? null, answers: values.answers ?? null,
    ref: values.ref ?? null, ...(implies ? { implies } : {}), ...marked }]);
  io.result?.({ item: id, fact });
  io.say(`fact ${fact.id} appended to #${id} as ${fact.kind}`);
  if (second === 'diagnosis' && store.getItem(board, id).item_route === 'strong') {
    io.say(`#${id} stays strong: a diagnosis never lowers a strong route by itself; suggested route: light`);
    io.say(`next: the coordinator runs: pullboard edit ${id} --route light`);
  }
  return 0;
});
}
