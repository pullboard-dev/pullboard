/** Browser-safe readers for an already decoded relay presentation [C7,H5,H15]. */
import { Refused } from '../../../../kernel/light.js';

/** Resolve one addressed shout from an already decoded snapshot without local repository access. */
export function presentationShout(presentation, id) {
  if (!Array.isArray(presentation?.shouts)) throw new Refused('SHOUT_NOT_AVAILABLE', 'this snapshot does not include addressed shout history; refresh it with a current CLI');
  const found = presentation.shouts.find((shout) => shout.shout_id === id);
  if (!found) throw new Refused('NO_SHOUT', `no shout #${id}`);
  const answer = found.shout_decision ? presentation.shouts.find((shout) => shout.shout_answers === id) ?? null : null;
  return { ...found, decision_state: found.shout_decision ? (answer ? 'answered' : 'open') : null, decision_answer: answer };
}

