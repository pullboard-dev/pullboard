import { compositionReviews } from '../../io/review/composition.js';
import { reviewPatchAuthors } from '../../io/review/composition.js';
/** A strict item no active seat could review is named at submit and by the sentinel, from the one native eligibility rule [C7,V4]. */
import { reviewEligibility } from './eligibility.js';
import { familyName } from './policy.js';
import { familyAliasesOf } from './policy.js';
import { Refused } from '../../../../kernel/index.js';
import { seatFamily } from '../../../../items/index.js';
import { withFamilyReads } from '../../../../items/index.js';

const SHOWN = 4;
/** The projection copy's status column; named once so no status write is mistaken for this read-only copy. */
const PROJECTED_STATUS = 'item_status';

/** Name each author who can exclude a reviewer family, with the family it declared (or none). */
function authorFamilies(board, item) {
  const aliases = familyAliasesOf(board);
  const declared = (id) => seatFamily(board, id);
  const rows = [{ role: 'builder', agent: item.item_built_by, family: familyName(item.item_builder_family ?? declared(item.item_built_by), aliases) }];
  for (const author of reviewPatchAuthors(board, item)) rows.push({ role: 'companion author', agent: author.agentId, family: familyName(declared(author.agentId), aliases) });
  return rows.filter(row => row.agent);
}

/**
 * Return null when the item is not strict, is not yet in review shape, or some registered seat that is not gone can review it.
 * Otherwise return the exact explanation. Eligibility is the same projection `pullboard show` prints.
 */
export function unreviewableStrict(board, item, options = {}, reads = board.nativePorts) {
  const { registered = false, ...eligibility } = options;
  const projected = reviewEligibility(board, item, eligibility, { strictOnly: true });
  if (projected.tier !== 'strict' || !projected.ready) return null;
  // A replayed move may not read local heartbeats, so it counts every registered seat; submit and the sentinel count only active ones.
  const present = new Map(reads.listAgents(board).map(seat => [seat.agent_id, registered ? 'registered' : seat.presence]));
  if (projected.eligible.some(agent => present.get(agent) !== 'gone')) return null;
  const authors = authorFamilies(board, item);
  const undeclared = authors.filter(row => !row.family);
  const excluding = authors.filter(row => row.family);
  const parts = [];
  for (const row of undeclared) parts.push(`${row.role} ${row.agent} has no declared vendor family, so strict review cannot be routed; declare it (pullboard join --family <vendor>) or re-register that seat with one`);
  if (excluding.length) parts.push(`${excluding.map(row => `${row.role} ${row.agent} (${row.family})`).join(' and ')} exclude${excluding.length === 1 ? 's' : ''} ${[...new Set(excluding.map(row => row.family))].join(' and ')} reviewers`);
  const seats = new Map(reads.listAgents(board).map(seat => [seat.agent_id, seat]));
  const aliases = familyAliasesOf(board);
  const silent = withFamilyReads(board, () => [...seats.values()].filter(seat => (registered || seat.presence !== 'gone') && !familyName(seatFamily(board, seat.agent_id), aliases) && !authors.some(row => row.agent === seat.agent_id)).map(seat => seat.agent_id));
  if (silent.length) parts.push(`active seat${silent.length === 1 ? '' : 's'} ${silent.slice(0, SHOWN).join(', ')}${silent.length > SHOWN ? ` +${silent.length - SHOWN} more` : ''} declare${silent.length === 1 ? 's' : ''} no vendor family, so strict review cannot route to ${silent.length === 1 ? 'it' : 'them'}`);
  const rules = projected.ineligible.slice(0, SHOWN).map(row => `${row.agent}: ${row.rule}`);
  const more = projected.ineligible.length - rules.length;
  const detail = rules.length ? `; no active seat remains (${rules.join('; ')}${more > 0 ? `; +${more} more` : ''})` : '; no registered seat is active';
  return { item: item.item_id, undeclared, excluding, eligibleButGone: projected.eligible,
    message: `#${item.item_id} is strict and no active registered seat could review it: ${parts.join('; ') || 'every seat is excluded'}${detail}`,
    fix: 'credit the companion to a custodian of another family, or declare the missing family on a seat that can review' };
}

/** The item as it will stand once submitted, so a claimed item can be projected before its submit exists. */
export function asSubmitted(board, item) {
  if (item.item_status !== 'claimed') return item;
  const owner = seatFamily(board, item.item_owner);
  return { ...item, [PROJECTED_STATUS]: 'submitted', item_built_by: compositionReviews(board) ? item.item_owner : item.item_built_by ?? item.item_owner, item_builder_family: compositionReviews(board) ? owner : item.item_builder_family ?? owner };
}

/** Refuse the submit that no active seat could review. */
export function refuseUnreviewable(board, item, options, reads = board.nativePorts) {
  const problem = unreviewableStrict(board, item, options, reads);
  if (problem) throw new Refused('NO_ELIGIBLE_REVIEWER', problem.message, problem.fix);
}
