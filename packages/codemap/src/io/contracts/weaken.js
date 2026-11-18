import { Refused } from '../../../../kernel/light.js';

/**
 * List how an export's shape got narrower between two versions: removed, a parameter dropped, or the return changed.
 * @param {{ name: string, params: string[], returns: string }[]} before exports the consumers hold today
 * @param {{ name: string, params: string[], returns: string }[]} after exports the change leaves
 * @returns {string[]} one line per weakening
 */
function weakenings(before, after) {
  const next = new Map(after.map(shape => [shape.name, shape]));
  const found = [];
  for (const shape of before) {
    const now = next.get(shape.name);
    if (!now) found.push(`${shape.name} is removed`);
    else if (now.params.length < shape.params.length) found.push(`${shape.name} drops a parameter`);
    else if (now.returns !== shape.returns) found.push(`${shape.name} changes its return from ${shape.returns} to ${now.returns}`);
  }
  return found;
}

/**
 * Refuse a contract change that weakens a shape unless the provider's owner approved it.
 * Why: consumers hold the old shape, so a narrower export breaks them; only the owner may accept that. The check is
 * behind gate.contractWeakening (off by default), so with the setting off nothing is refused [C7].
 * @param {{ enabled?: boolean, owner: string, before: object[], after: object[], beforeFingerprint?: string, afterFingerprint?: string, approvedBy?: string[] }} change
 * @returns {{ weakened: string[] }} what narrowed; empty when nothing was refused or nothing narrowed
 */
export function checkContractWeakening({ enabled = false, owner, before, after, beforeFingerprint, afterFingerprint, approvedBy = [] }) {
  if (!enabled || beforeFingerprint === afterFingerprint) return { weakened: [] };
  const weakened = weakenings(before, after);
  if (weakened.length > 0 && !approvedBy.includes(owner)) {
    throw new Refused('CONTRACT_WEAKENED', `${weakened.join('; ')}, which weakens the contract owned by ${owner}; ask ${owner} to approve the change and record the approval, then retry`);
  }
  return { weakened };
}
