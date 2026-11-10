/** Exercise optional native renewal metadata without manufacturing production proof authority [A5,V4,H16]. */
import {
  openBoard,
  closeBoard,
} from '../../../../src/logic/native.js';
import { board_ensureCoordinator as ensureCoordinator } from '../../../../../../packages/store/index.js';
import { register } from '../../../../../../packages/store/index.js';
import { addItem } from '../../../../../../packages/store/index.js';
import { claim } from '../../../../../../packages/store/index.js';
import { events } from '../../../../../../packages/store/index.js';

/** Return the actual optional-field union alongside the existing ordinary renew fixture rows. */
export function pipelineEventContract() {
  const board = openBoard(':memory:');
  try {
    const coordinator = ensureCoordinator(board, '/pipeline-format-coordinator');
    const builder = register(board, { lane: 'docs', path: '/pipeline-format-builder' });
    const id = addItem(board, { by: coordinator, lane: 'docs', title: 'Pipeline event format fixture', check: 'true' });
    const options = { agentId: builder, lane: 'docs', leaseMs: 3_600_000, freeze: () => ({ text: '{}', digest: 'pipeline-format-bar' }) };
    claim(board, id, options);
    claim(board, id, { ...options, submitAdmission: { id: '00000001-0000-4000-8000-000000000000', commit: 'a'.repeat(40), tree: 'b'.repeat(40) } });
    claim(board, id, { ...options, submitOutcome: { digest: 'pipeline-format-bar', code: 'RUNNER_WAIT_DEADLINE', text: 'Synthetic format fixture runner deadline.' } });
    return events(board).filter(row => row.event_kind === 'renew').map(row => ({ ...row, detail: JSON.parse(row.event_detail) }));
  } finally { closeBoard(board); }
}
