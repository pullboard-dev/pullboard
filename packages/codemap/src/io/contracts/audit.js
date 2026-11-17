import { Refused } from '../../../../kernel/light.js';
import { checkShape } from '../../logic/contracts/shape.js';
import { writeContractFile } from './file.js';

/**
 * Audit a provider's actual exports against the shapes declared for them: a mismatch is refused, a gap drafts a contract.
 * Why: a mismatch breaks a contract consumers hold, so it stops the change; a gap only lacks one, so the audit writes a
 * draft the owner can review. Behind gate.contractAudit (off by default): with it off nothing is refused or written [C7].
 * @param {{ enabled?: boolean, consumer: string, provider: string, declared: object[], actual: object[], draftPath: string }} audit
 * @returns {{ drafted: string[] }} paths of the draft contract files written
 */
export function auditContractGaps({ enabled = false, consumer, provider, declared, actual, draftPath }) {
  if (!enabled) return { drafted: [] };
  const byName = new Map(declared.map(shape => [shape.name, shape]));
  const gaps = [];
  const mismatches = [];
  for (const shape of actual) {
    const finding = checkShape(byName.get(shape.name), shape);
    if (finding?.kind === 'mismatch') mismatches.push(`${finding.export}: ${finding.difference}`);
    else if (finding) gaps.push(shape);
  }
  if (mismatches.length > 0) {
    throw new Refused('CONTRACT_SHAPE_MISMATCH', `${provider} no longer matches the shapes declared for it (${mismatches.join('; ')}); restore the shape or have the owner update the declared contract, then retry`);
  }
  if (gaps.length === 0) return { drafted: [] };
  writeContractFile(draftPath, { consumer, provider, exports: gaps.map(({ name, params, returns }) => ({ name, params, returns })) });
  return { drafted: [draftPath] };
}
