/** Exercise landing adoption against real private Git worktrees [B3,R3]. */
import { test } from 'node:test';

// CONTROLLER_ONLY: adoption recovers the in-process batch of a killed coordinator; a pulled land job has no batch to adopt [B3,R3].
test('land adoption recovers an interrupted gate and keeps one receipt under a new coordinator [B3,R3]', { skip: 'CONTROLLER_ONLY: deleted with #6807' }, () => {});
