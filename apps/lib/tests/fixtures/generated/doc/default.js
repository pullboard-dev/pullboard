/** Exercise the migration's actual event for the format manifest, without claiming gate evidence [A5,V4,H16]. */
import {
  openBoard,
  closeBoard,
} from '../../../../src/logic/native.js';
import { board_ensureCoordinator as ensureCoordinator } from '../../../../../../packages/store/index.js';
import { register } from '../../../../../../packages/store/index.js';
import { addItem } from '../../../../../../packages/store/index.js';
import { claim } from '../../../../../../packages/store/index.js';
import { appendFact } from '../../../../../../packages/store/index.js';
import { events } from '../../../../../../packages/store/index.js';
import { REVIEW_DEFAULT_ENGINE } from '../../../../../../packages/state/light.js';
import { submitFixture } from '../../../../../cli/tests/fixtures/board/submit.js';

/** Upgrade a genuine old fixture prefix and return only its new typed board event. */
export function reviewDefaultEventContract() {
  const board = openBoard(':memory:');
  try {
    board.executionEngineVersion = REVIEW_DEFAULT_ENGINE - 1;
    const coordinator = ensureCoordinator(board, '/format-coordinator');
    const builder = register(board, { id: 'core-1', lane: 'core', path: '/format-builder', family: 'OpenAI', model: 'Explicit format fixture' });
    const id = addItem(board, { by: coordinator, lane: 'core', title: 'Review migration format fixture', check: 'true' });
    claim(board, id, { agentId: builder, lane: 'core', leaseMs: 3_600_000,
      freeze: () => ({ text: '{}', digest: 'synthetic-format-review-default' }) });
    submitFixture(board, id, { agentId: builder, commit: 'a'.repeat(40), tree: 'b'.repeat(40), files: ['src/quarantine.js'] });
    delete board.executionEngineVersion;
    appendFact(board, id, { agentId: coordinator, kind: 'note', text: 'Format-only migration activation.' });
    return events(board).filter(row => row.event_kind === 'review-default').map(row => ({ ...row, detail: JSON.parse(row.event_detail) }));
  } finally { closeBoard(board); }
}
