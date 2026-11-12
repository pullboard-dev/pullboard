/**
 * What setup asks about spec rows (#848): a row the person has already decided waits for the
 * coordinator's spec apply, never for the person again, and each open row gets the command that
 * decides it, approve for a draft and answer for a pending question.
 */
import { decisionProjection } from '../row/decisions.js';
import { rowDecisionContext } from '../row/stale.js';

/** Include stale decisions even when the current file row was already marked approved. */
export function setupDecisionRows(root, config, records, rows) {
  const context = rowDecisionContext(root, config);
  return rows.map(row => decisionProjection(records, row, 'spec', context))
    .filter(row => row.status === 'draft' || row.status === 'pending' || row.staleDecision);
}

/** Show available starter work beside undecided rows, without changing any approval or apply move [S1,B26]. */
export function withStarterWork(setup, { board, me, main, config, root, seat, nextFor, proposeLanes }) {
  if (setup?.waitingOn !== 'person-approval') return setup;
  const meanwhile = seat
    ? 'While waiting, review independent approved work or send questions to the coordinator with pullboard shout coordinator --kind question "<what is needed>" --decision.'
    : 'While waiting, the agent may review independent approved work or prepare questions for the person.';
  const waiting = { ...setup, meanwhile };
  const proposed = main ? proposeLanes(root, config) : [];
  const lanes = Object.entries(config.lanes).filter(([, lane]) => lane.owns.length).map(([name]) => name);
  if (!main && !lanes.includes(me.lane)) return waiting;
  const item = nextFor(board, { agentId: me.id, lane: me.lane,
    ...(main ? { lanes: [...lanes, ...proposed.map(lane => lane.name)] } : {}) }).item;
  if (!item || (main && ![...lanes, ...proposed.map(lane => lane.name)].includes(item.item_lane))) return waiting;
  /** Quote a configured path only when the command needs it. */
  const word = value => /^[A-Za-z0-9._/,-]+$/u.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
  const proposal = proposed.find(lane => lane.name === item.item_lane);
  const command = !main ? `pullboard claim ${item.item_id}` : !Object.hasOwn(config.lanes, item.item_lane)
    ? `pullboard lane add ${item.item_lane} --owns ${word(proposal.owns.join(','))}`
    : `pullboard worktree ${item.item_lane} --model "<model name>"`;
  return { ...waiting,
    buildNow: { item: item.item_id, lane: item.item_lane, title: item.item_title, command },
    meanwhile: `Starter items can be claimed and built now while the person decides these rows in parallel. First: #${item.item_id} ${item.item_title}. Start: ${command}`,
    agentNext: main && setup.approvedRowIds?.length ? 'pullboard spec apply' : command };
}

/** Keep spec setup optional on a working rowless board, retaining approval guidance for real rows. */
export function requirementStep({ rows, drafted, toApply, completed, hasItems }) {
  const optional = rows.length === 0 && hasItems;
  return { number: 1, done: optional || (rows.some(row => row.status === 'approved') && ((!drafted.length && !toApply.length) || completed)),
    question: optional ? 'Spec rows are optional on this working board; add a requirement later with pullboard spec draft "<text>".'
      : 'Ask the person: what are we building, and who will use it? Draft a few requirements, then ask the person to approve them.',
    command: 'pullboard spec draft "<text>"',
    afterAnswer: 'Record each answer with pullboard spec draft "<text>"; the person approves the returned ids in Pullboard View or runs pullboard spec approve <ids> in their own terminal; then the coordinator runs pullboard spec apply.' };
}

/**
 * The setup step once every open row has a person decision that spec apply has not written yet.
 *
 * @param {string[]} rowIds The decided rows waiting for apply.
 * @param {boolean} seat Whether an agent seat, not the coordinator, is reading it.
 * @returns {{waitingOn: string, rowIds: string[], question: string, command: string, afterAnswer: string, agentNext: string}}
 */
export function applyStep(rowIds, seat) {
  const names = rowIds.join(', ');
  return { waitingOn: 'coordinator-apply', rowIds,
    question: seat ? `The person approved ${names}; the coordinator applies them.` : `The person approved ${names}; apply them: pullboard spec apply.`, command: 'pullboard spec apply',
    afterAnswer: 'spec apply writes the person’s decisions into SPEC.md; then commit SPEC.md so every worktree reads them.',
    agentNext: seat ? `ask the coordinator to apply ${names}: pullboard shout coordinator --kind question "the person approved ${names}; please run pullboard spec apply"` : 'pullboard spec apply, then commit SPEC.md' };
}

/**
 * The person's command for the rows still open, and the verb that names it: approve for drafts,
 * answer for pending questions, decide for a mix.
 *
 * @param {{id: string, status: string}[]} rows The open rows with no person decision.
 * @returns {{personCommand: string, verb: string, seatQuestion: string, seatNext: string}}
 */
export function personAsk(rows) {
  const questions = rows.filter(row => row.status === 'pending').map(row => row.id);
  const drafts = rows.filter(row => row.status !== 'pending').map(row => row.id);
  const personCommand = [drafts.length ? `pullboard spec approve ${drafts.join(',')}` : '', ...questions.map(id => `pullboard spec answer ${id} "<choice>"`)].filter(Boolean).join('; ');
  const verb = !questions.length ? 'approve' : drafts.length ? 'decide' : 'answer';
  const names = rows.map(row => row.id).join(', ');
  const request = verb === 'approve' ? `bring approval of ${names} to the person` : `ask the person to ${verb} ${names}`;
  return { personCommand, verb,
    seatQuestion: `Waiting for the coordinator to ${request}.`,
    seatNext: `ask the coordinator to ${request}: pullboard shout coordinator --kind question "${verb} ${names}" --decision; meanwhile pullboard spec show ${rows[0].id}` };
}
