/** next prints this seat's open health advice under the build instruction when health.adviceThroughNext is on [C7,#2330]. */
import { adviceThroughNextEnabled } from '../../../../../packages/config/index.js';
import { recordedHealthFindings } from '../../../../../packages/sentinels/index.js';

/**
 * One line per recorded health finding owned by this builder seat, from its title and next step.
 * Why: advice that would be sent as a shout is read in the next output instead, and with the setting off the findings are never read [C7,#2330].
 * @param {object} board The board to read the last health scan from.
 * @param {string} agentId This seat's agent id.
 * @param {{ enabled?: boolean, read?: (board: object) => { findings: object[] } }} [options] Both are injected by tests.
 * @returns {string[]}
 */
export function healthAdviceLines(board, agentId, { enabled = adviceThroughNextEnabled(), read = recordedHealthFindings } = {}) {
  if (!enabled) return [];
  return read(board).findings
    .filter(finding => finding.owner?.role === 'builder' && finding.owner?.who === agentId)
    .map(finding => `health: ${finding.title}${finding.next ? `; ${finding.next}` : ''}`);
}
